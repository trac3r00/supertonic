"""Typer command surface for truthful validation receipts."""

from __future__ import annotations

import pathlib
import sys
from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated, Final

import typer

from supertonic_verify.models import ChildExecution, EvidenceClass, EvidenceReceipt, Outcome
from supertonic_verify.runner import (
    CommandResult,
    EvidenceRun,
    InvocationError,
    assert_expected_identity,
    collect_host,
    collect_identity,
    execute_child,
    load_expected_identity,
    redact_and_bound,
    reject_nonfinite_child_status,
    repository_root,
    utc_now,
    write_receipt,
)

if TYPE_CHECKING:
    from collections.abc import Callable

app = typer.Typer(
    add_completion=False,
    help="Execute truthful Supertonic validation scenarios and retain immutable receipts.",
    no_args_is_help=True,
)

RUNTIMES: Final = frozenset(
    {"py", "nodejs", "web", "cpp", "rust", "go", "csharp", "java", "swift", "ios", "flutter"}
)
PREFLIGHT_SCENARIOS: Final = frozenset(
    {"missing-assets", "receipt-fixture", "reject-nonfinite-status", "reject-missing-receipt"}
)
EXIT_CODES: Final = {
    "verified": 0,
    "assertion_failure": 1,
    "invalid_invocation": 2,
    "missing_prerequisite": 77,
}


@dataclass(frozen=True, slots=True)
class ScenarioReport:
    """Hold one scenario conclusion before cleanup creates a receipt."""

    children: tuple[ChildExecution, ...]
    errors: tuple[str, ...]
    evidence_class: EvidenceClass
    outcome: Outcome


@dataclass(frozen=True, slots=True)
class ReceiptDraft:
    """Hold receipt fields that are independent of runtime cleanup."""

    command: tuple[str, ...]
    report: ScenarioReport


def _write(run: EvidenceRun, draft: ReceiptDraft) -> CommandResult:
    """Finalize a receipt after cleanup, then return the normative exit status."""
    receipt = EvidenceReceipt(
        assertion_errors=tuple(redact_and_bound(error) for error in draft.report.errors),
        children=draft.report.children,
        cleanup=run.cleanup(),
        claimable_for=(),
        command=tuple(redact_and_bound(argument) for argument in draft.command),
        completed_at=utc_now(),
        evidence_class=draft.report.evidence_class,
        ephemeral_port=run.port,
        host=collect_host(),
        identity=collect_identity(repository_root()),
        inference_proof=False,
        outcome=draft.report.outcome,
        scratch_dir=str(run.scratch_dir),
        started_at=utc_now(),
    )
    return CommandResult(EXIT_CODES[receipt.outcome], write_receipt(run, receipt))


def _preflight_report(scenario: str, identity_errors: tuple[str, ...]) -> ScenarioReport:
    """Produce one explicit task3 scenario result without any mock runtime."""
    if identity_errors:
        return ScenarioReport((), identity_errors, "rejection", "assertion_failure")
    match scenario:
        case "missing-assets":
            return ScenarioReport(
                (),
                ("required immutable assets are unavailable for this scenario",),
                "preflight",
                "missing_prerequisite",
            )
        case "reject-nonfinite-status":
            return ScenarioReport(
                (),
                reject_nonfinite_child_status(),
                "rejection",
                "assertion_failure",
            )
        case "reject-missing-receipt":
            return ScenarioReport(
                (),
                ("required prior receipt is absent",),
                "rejection",
                "assertion_failure",
            )
        case "receipt-fixture":
            children = _fixture_children()
            expected_outcomes = ("success", "failed", "timeout")
            errors = tuple(
                f"fixture child {index} outcome mismatch"
                for index, child in enumerate(children)
                if child.outcome != expected_outcomes[index]
            )
            return ScenarioReport(
                children,
                errors,
                "harness_fixture",
                "assertion_failure" if errors else "verified",
            )
        case _:
            return ScenarioReport(
                (),
                (f"scenario {scenario!r} is not implemented",),
                "rejection",
                "invalid_invocation",
            )


def _fixture_children() -> tuple[ChildExecution, ...]:
    """Run fixed local argv that exercise only dispatcher behavior."""
    return (
        execute_child((sys.executable, "-m", "supertonic_verify.fixture_child", "success"), 1),
        execute_child((sys.executable, "-m", "supertonic_verify.fixture_child", "failure"), 1),
        execute_child((sys.executable, "-m", "supertonic_verify.fixture_child", "timeout"), 0.01),
    )


def _open_evidence(evidence: str) -> EvidenceRun:
    """Refuse unusable destinations without echoing private paths or modifying files."""
    try:
        return EvidenceRun(pathlib.Path(evidence))
    except OSError:
        typer.echo(
            "invalid_invocation: evidence destination is not writable as a directory",
            err=True,
        )
        raise typer.Exit(2) from None


@app.command()
def preflight(
    scenario: Annotated[str, typer.Option(help="Explicit checked-in scenario name.")],
    evidence: Annotated[
        str,
        typer.Option(help="Parent directory for private run receipts."),
    ],
    expected_identity: Annotated[
        str | None,
        typer.Option(help="Optional JSON file containing expected immutable input identities."),
    ] = None,
) -> None:
    """Run implemented prerequisite and harness-only checks."""
    run = _open_evidence(evidence)
    try:
        errors = assert_expected_identity(
            collect_identity(repository_root()),
            load_expected_identity(
                None if expected_identity is None else pathlib.Path(expected_identity)
            ),
        )
    except InvocationError as error:
        report = ScenarioReport((), (str(error),), "rejection", "invalid_invocation")
    else:
        report = _preflight_report(scenario, errors)
    result = _write(run, ReceiptDraft(("preflight", "--scenario", scenario), report))
    typer.echo(result.receipt_path)
    raise typer.Exit(result.exit_code)


@app.command()
def conformance(
    runtime: Annotated[str, typer.Option(help="Named runtime driver.")],
    evidence: Annotated[
        str,
        typer.Option(help="Parent directory for private run receipts."),
    ],
) -> None:
    """Reject unknown and task3-unimplemented real runtime drivers."""
    message = (
        f"runtime {runtime!r} is unknown"
        if runtime not in RUNTIMES
        else f"runtime {runtime!r} has no implemented task3 conformance scenario"
    )
    result = _write(
        _open_evidence(evidence),
        ReceiptDraft(
            ("conformance", "--runtime", runtime),
            ScenarioReport((), (message,), "rejection", "invalid_invocation"),
        ),
    )
    typer.echo(result.receipt_path)
    raise typer.Exit(result.exit_code)


def _unimplemented(command: str) -> Callable[[], None]:
    """Create a precise rejection handler for one documented future command."""

    def handler() -> None:
        """Reject the future command rather than fabricating execution."""
        typer.echo(f"{command} is documented but not implemented by task3", err=True)
        raise typer.Exit(2)

    return handler


for command_name in (
    "baseline",
    "packages",
    "bench",
    "quality",
    "http",
    "browser",
    "mobile",
    "hardware",
    "cluster",
    "release",
):
    _ = app.command(name=command_name, help=f"Documented future {command_name} command.")(
        _unimplemented(command_name)
    )
