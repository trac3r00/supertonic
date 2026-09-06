"""Typer command surface for truthful validation receipts."""

from __future__ import annotations

import json
import pathlib
import shutil
import sys
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Annotated, Final, cast

import typer
from pydantic import ValidationError

from supertonic_verify.models import (
    ChildExecution,
    DependencyMutationContract,
    DependencyResolution,
    EvidenceClass,
    EvidenceReceipt,
    OrtDistribution,
    Outcome,
)
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

RUNTIMES: Final = (
    "py",
    "nodejs",
    "web",
    "cpp",
    "rust",
    "go",
    "csharp",
    "java",
    "swift",
    "ios",
    "flutter",
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
CHECKER_INVALID_INVOCATION_EXIT: Final = EXIT_CODES["invalid_invocation"]
CHECKER_MISSING_PREREQUISITE_EXIT: Final = EXIT_CODES["missing_prerequisite"]
PACKAGE_SCENARIOS: Final = frozenset({"dependency-resolution", "mixed-ort-distributions"})
DEPENDENCY_CONTRACT_UNAVAILABLE: Final = "dependency contract is unavailable for mutation"
DEPENDENCY_CONTRACT_INVALID: Final = "dependency contract is invalid for mutation"
DEPENDENCY_ORT_DISTRIBUTION_UNAVAILABLE: Final = (
    "dependency contract has no ORT distribution to mutate"
)
DEPENDENCY_LOCKFILE_UNAVAILABLE: Final = "dependency lockfile is unavailable for mutation"
DEPENDENCY_LOCKFILE_ESCAPES_ROOT: Final = "dependency lockfile escapes mutation root"


@dataclass(frozen=True, slots=True)
class ScenarioReport:
    """Hold one scenario conclusion before cleanup creates a receipt."""

    children: tuple[ChildExecution, ...]
    errors: tuple[str, ...]
    evidence_class: EvidenceClass
    outcome: Outcome
    selected_runtimes: tuple[str, ...] = ()


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
        selected_runtimes=draft.report.selected_runtimes,
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


def _dependency_contract_path(root: pathlib.Path) -> pathlib.Path:
    """Return the fixed checked-in dependency contract path."""
    return root / "contracts" / "v1" / "dependencies.json"


def _dependency_checker_path(root: pathlib.Path) -> pathlib.Path:
    """Return the fixed checker used by the package scenarios."""
    return root / "tools" / "contracts" / "check.mjs"


def _dependency_prerequisite_report(
    children: tuple[ChildExecution, ...],
    message: str,
) -> ScenarioReport:
    """Return an unverified result without converting metadata into a host claim."""
    return ScenarioReport(children, (message,), "preflight", "missing_prerequisite")


def _load_dependency_mutation_contract(
    dependencies_path: pathlib.Path,
) -> tuple[dict[str, object], DependencyMutationContract]:
    """Parse the trusted shape required to stage a scratch-only negative contract."""
    try:
        raw_value = cast("object", json.loads(dependencies_path.read_text(encoding="utf-8")))
        if not isinstance(raw_value, dict):
            raise InvocationError(DEPENDENCY_CONTRACT_INVALID)
        raw = cast("dict[str, object]", raw_value)
        return raw, DependencyMutationContract.model_validate(raw)
    except OSError as error:
        raise InvocationError(DEPENDENCY_CONTRACT_UNAVAILABLE) from error
    except (json.JSONDecodeError, ValidationError) as error:
        raise InvocationError(DEPENDENCY_CONTRACT_INVALID) from error


def _append_mixed_ort_distribution(
    raw: dict[str, object],
    distribution: OrtDistribution,
) -> None:
    """Append an opposite variant with the same real package and environment."""
    distributions = raw.get("ortDistributions")
    if not isinstance(distributions, list):
        raise InvocationError(DEPENDENCY_CONTRACT_INVALID)
    mutable_distributions = cast("list[object]", distributions)
    opposite: str = "gpu" if distribution.variant == "cpu" else "cpu"
    mutable_distributions.append(
        {
            "environmentId": distribution.environment_id,
            "package": distribution.package,
            "runtime": distribution.runtime,
            "variant": opposite,
        }
    )


def _copy_staged_lockfiles(
    resolutions: tuple[DependencyResolution, ...],
    dependencies_path: pathlib.Path,
    staged_path: pathlib.Path,
    staged_root: pathlib.Path,
) -> None:
    """Copy only resolved lockfiles into the matching scratch-relative locations."""
    for resolution in resolutions:
        for lockfile in (
            resolution.lockfile,
            *resolution.additional_lockfiles,
            *resolution.source_files,
        ):
            source_lock = (dependencies_path.parent / lockfile.path).resolve()
            staged_lock = (staged_path.parent / lockfile.path).resolve()
            if not staged_lock.is_relative_to(staged_root):
                raise InvocationError(DEPENDENCY_LOCKFILE_ESCAPES_ROOT)
            try:
                staged_lock.parent.mkdir(parents=True, exist_ok=True)
                _ = shutil.copy2(source_lock, staged_lock)
            except OSError as error:
                raise InvocationError(DEPENDENCY_LOCKFILE_UNAVAILABLE) from error


def _stage_mixed_ort_contract(
    dependencies_path: pathlib.Path,
    scratch_dir: pathlib.Path,
) -> pathlib.Path:
    """Copy a checked dependency contract and flip one real ORT variant."""
    raw, contract = _load_dependency_mutation_contract(dependencies_path)
    if not contract.ort_distributions:
        raise InvocationError(DEPENDENCY_ORT_DISTRIBUTION_UNAVAILABLE)
    _append_mixed_ort_distribution(raw, contract.ort_distributions[0])
    staged_root = (scratch_dir / "dependency-mutation").resolve()
    staged_path = staged_root / "contracts" / "v1" / "dependencies.json"
    staged_path.parent.mkdir(parents=True, exist_ok=False)
    _copy_staged_lockfiles(contract.resolutions, dependencies_path, staged_path, staged_root)
    _ = staged_path.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")
    return staged_path


def _packages_report(
    runtime: str,
    scenario: str,
    run: EvidenceRun,
) -> ScenarioReport:
    """Run fixed package checks without treating static metadata as native qualification."""
    selected = "nodejs" if runtime == "node" else runtime
    if selected != "all" and selected not in RUNTIMES:
        return ScenarioReport(
            (),
            (f"runtime {runtime!r} is unknown",),
            "rejection",
            "invalid_invocation",
        )
    if scenario not in PACKAGE_SCENARIOS:
        return ScenarioReport(
            (),
            (f"scenario {scenario!r} is not implemented",),
            "rejection",
            "invalid_invocation",
        )
    if scenario == "mixed-ort-distributions" and selected != "all":
        return ScenarioReport(
            (),
            ("mixed-ort-distributions requires runtime all",),
            "rejection",
            "invalid_invocation",
        )
    return replace(
        _checked_packages_report(scenario, run, selected),
        selected_runtimes=RUNTIMES if selected == "all" else (selected,),
    )


def _dependency_checker_invocation(
    root: pathlib.Path,
) -> tuple[str, pathlib.Path, pathlib.Path] | ScenarioReport:
    """Return a fixed checker invocation or an honest missing-prerequisite report."""
    dependencies_path = _dependency_contract_path(root)
    checker_path = _dependency_checker_path(root)
    node = shutil.which("node")
    if node is None:
        return _dependency_prerequisite_report((), "node is unavailable for dependency validation")
    if not dependencies_path.is_file() or not checker_path.is_file():
        return _dependency_prerequisite_report(
            (),
            "required dependency contract or checker is unavailable",
        )
    return node, dependencies_path, checker_path


def _checked_packages_report(
    scenario: str,
    run: EvidenceRun,
    runtime: str = "all",
) -> ScenarioReport:
    """Classify a real dependency checker result for one registered package scenario."""
    invocation = _dependency_checker_invocation(repository_root())
    if isinstance(invocation, ScenarioReport):
        return invocation
    node, dependencies_path, checker_path = invocation
    checker_argv = (node, str(checker_path), "--dependencies", str(dependencies_path))
    if runtime != "all":
        checker_argv += ("--runtime", runtime)
    resolution = execute_child(checker_argv, 30)
    if resolution.exit_code == CHECKER_MISSING_PREREQUISITE_EXIT:
        return _dependency_prerequisite_report(
            (resolution,),
            "dependency resolution prerequisites are unverified",
        )
    if resolution.exit_code != 0:
        return ScenarioReport(
            (resolution,),
            ("dependency resolution checker did not validate the checked-in contract",),
            "rejection",
            "assertion_failure",
        )
    if scenario == "dependency-resolution":
        return ScenarioReport((resolution,), (), "preflight", "verified")
    try:
        mixed_path = _stage_mixed_ort_contract(dependencies_path, run.scratch_dir)
    except InvocationError as error:
        return _dependency_prerequisite_report((resolution,), str(error))
    rejection = execute_child((node, str(checker_path), "--dependencies", str(mixed_path)), 30)
    return (
        ScenarioReport((resolution, rejection), (), "preflight", "verified")
        if rejection.exit_code == CHECKER_INVALID_INVOCATION_EXIT
        else ScenarioReport(
            (resolution, rejection),
            ("mixed ORT distributions were not rejected",),
            "rejection",
            "assertion_failure",
        )
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


@app.command()
def packages(
    runtime: Annotated[str, typer.Option(help="Runtime name (node aliases nodejs), or all.")],
    scenario: Annotated[str, typer.Option(help="Explicit checked-in package scenario name.")],
    evidence: Annotated[
        str,
        typer.Option(help="Parent directory for private run receipts."),
    ],
) -> None:
    """Run dependency-resolution scenarios with truthful prerequisite outcomes."""
    run = _open_evidence(evidence)
    result = _write(
        run,
        ReceiptDraft(
            ("packages", "--runtime", runtime, "--scenario", scenario),
            _packages_report(runtime, scenario, run),
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
