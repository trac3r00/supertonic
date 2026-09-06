"""Black-box behavior tests for the truthful validation command."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import anyio
import pytest

from supertonic_verify.models import EvidenceReceipt

ROOT = Path(__file__).resolve().parents[3]
PROJECT = ROOT / "tools" / "validation"


@dataclass(frozen=True, slots=True)
class CliResult:
    """Represent one actual console invocation in the black-box tests."""

    returncode: int
    stderr: str
    stdout: str


async def _run_cli(arguments: tuple[str, ...]) -> CliResult:
    """Run the real installed command through AnyIO without a shell."""
    completed = await anyio.run_process(
        ("uv", "run", "--project", str(PROJECT), "supertonic-verify", *arguments),
        cwd=ROOT,
        check=False,
    )
    return CliResult(
        returncode=completed.returncode,
        stderr=completed.stderr.decode("utf-8", errors="replace"),
        stdout=completed.stdout.decode("utf-8", errors="replace"),
    )


def run_cli(*arguments: str) -> CliResult:
    """Run the installed command through its isolated uv project."""
    return anyio.run(_run_cli, arguments)


def load_single_receipt(evidence_dir: Path) -> EvidenceReceipt:
    """Load exactly one receipt emitted by one CLI invocation."""
    receipts = list(evidence_dir.glob("run-*/receipt.json"))
    assert len(receipts) == 1
    return EvidenceReceipt.model_validate_json(receipts[0].read_text(encoding="utf-8"))


def test_help_documents_every_contract_command() -> None:
    """The real command advertises all contract command families."""
    result = run_cli("--help")

    assert result.returncode == 0, result.stderr
    for command in (
        "preflight",
        "baseline",
        "conformance",
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
        assert command in result.stdout


def test_unknown_runtime_is_an_invalid_invocation(tmp_path: Path) -> None:
    """Unregistered runtimes never become a fake passing scenario."""
    result = run_cli(
        "conformance",
        "--runtime",
        "nonexistent",
        "--evidence",
        str(tmp_path / "unknown"),
    )

    assert result.returncode == 2


def test_dependency_resolution_validates_metadata_without_claiming_native_host_proof(
    tmp_path: Path,
) -> None:
    """A lock-resolved contract passes while remaining non-claimable for native proof."""
    evidence_dir = tmp_path / "dependency-resolution"
    result = run_cli(
        "packages",
        "--runtime",
        "all",
        "--scenario",
        "dependency-resolution",
        "--evidence",
        str(evidence_dir),
    )

    assert result.returncode == 0, result.stderr
    receipt = load_single_receipt(evidence_dir)
    assert receipt.outcome == "verified"
    assert receipt.evidence_class == "preflight"
    assert receipt.claimable_for == ()
    assert receipt.inference_proof is False


def test_mixed_ort_distributions_are_rejected_by_the_real_packages_cli(
    tmp_path: Path,
) -> None:
    """The registered negative scenario must fail only the mutated scratch contract."""
    evidence_dir = tmp_path / "mixed-ort-distributions"
    result = run_cli(
        "packages",
        "--runtime",
        "all",
        "--scenario",
        "mixed-ort-distributions",
        "--evidence",
        str(evidence_dir),
    )

    assert result.returncode == 0, result.stderr
    receipt = load_single_receipt(evidence_dir)
    assert receipt.outcome == "verified"
    assert [child.exit_code for child in receipt.children] == [0, 2]
    assert receipt.claimable_for == ()
    assert receipt.inference_proof is False


def test_future_package_scenario_is_rejected_with_a_receipt(tmp_path: Path) -> None:
    evidence_dir = tmp_path / "future-package"
    result = run_cli(
        "packages",
        "--runtime",
        "all",
        "--scenario",
        "future-package-success",
        "--evidence",
        str(evidence_dir),
    )

    assert result.returncode == 2, result.stderr
    receipt = load_single_receipt(evidence_dir)
    assert receipt.outcome == "invalid_invocation"


@pytest.mark.parametrize(
    ("runtime", "selected"),
    [
        ("py", ("py",)),
        ("node", ("nodejs",)),
        ("nodejs", ("nodejs",)),
        ("web", ("web",)),
        ("go", ("go",)),
        (
            "all",
            (
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
            ),
        ),
    ],
)
def test_package_runtime_selection(
    tmp_path: Path,
    runtime: str,
    selected: tuple[str, ...],
) -> None:
    evidence = tmp_path / runtime
    result = run_cli(
        "packages",
        "--runtime",
        runtime,
        "--scenario",
        "dependency-resolution",
        "--evidence",
        str(evidence),
    )
    assert result.returncode == 0, result.stderr
    receipt = load_single_receipt(evidence)
    assert receipt.command == (
        "packages",
        "--runtime",
        runtime,
        "--scenario",
        "dependency-resolution",
    )
    assert receipt.selected_runtimes == selected
    assert receipt.outcome == "verified"
    assert receipt.claimable_for == ()
    assert receipt.inference_proof is False
    assert [child.exit_code for child in receipt.children] == [0]
    assert receipt.cleanup.scratch_removed
    assert not Path(receipt.scratch_dir).exists()
    if runtime != "all":
        assert '"runtimes": [\n    "' + selected[0] + '"\n  ]' in receipt.children[0].stdout


def test_unknown_package_runtime_stays_invalid(tmp_path: Path) -> None:
    evidence = tmp_path / "unknown"
    result = run_cli(
        "packages",
        "--runtime",
        "unknown",
        "--scenario",
        "dependency-resolution",
        "--evidence",
        str(evidence),
    )
    assert result.returncode == 2
    receipt = load_single_receipt(evidence)
    assert receipt.outcome == "invalid_invocation"
    assert receipt.children == ()


def test_missing_assets_are_unverified_not_success(tmp_path: Path) -> None:
    """An absent immutable asset prerequisite exits with the designated status."""
    result = run_cli(
        "preflight",
        "--scenario",
        "missing-assets",
        "--evidence",
        str(tmp_path / "missing"),
    )

    assert result.returncode == 77
    receipt = load_single_receipt(tmp_path / "missing")
    assert receipt.outcome == "missing_prerequisite"


def test_future_scenario_is_rejected_instead_of_mocked(tmp_path: Path) -> None:
    """A future scenario name is never silently simulated."""
    result = run_cli(
        "preflight",
        "--scenario",
        "future-model-success",
        "--evidence",
        str(tmp_path / "future"),
    )

    assert result.returncode == 2


def test_documented_future_command_emits_a_precise_error() -> None:
    """A listed future command reports its task boundary rather than looking successful."""
    result = run_cli("baseline")

    assert result.returncode == 2
    assert "not implemented by task3" in result.stderr


def test_fixture_records_real_child_statuses_and_redacts_output(tmp_path: Path) -> None:
    """The harness-only fixture retains success, failure, and timeout honestly."""
    evidence_dir = tmp_path / "fixture"
    result = run_cli("preflight", "--scenario", "receipt-fixture", "--evidence", str(evidence_dir))

    assert result.returncode == 0, result.stderr
    receipt = load_single_receipt(evidence_dir)
    assert receipt.evidence_class == "harness_fixture"
    assert receipt.claimable_for == ()
    assert receipt.inference_proof is False
    assert [child.outcome for child in receipt.children] == [
        "success",
        "failed",
        "timeout",
    ]
    assert receipt.children[1].exit_code == 23
    assert receipt.children[2].exit_code is None
    rendered = receipt.model_dump_json()
    assert "SYNTHETIC_SECRET_DO_NOT_LOG" not in rendered
    assert "***REDACTED***" in rendered
    run_dir = next(evidence_dir.glob("run-*"))
    assert (run_dir / "cleanup.json").is_file()
    assert not (run_dir / "resources.json").exists()
    assert not Path(receipt.scratch_dir).exists()


@pytest.mark.parametrize(
    ("scenario", "expected_exit"),
    [
        ("reject-nonfinite-status", 1),
        ("reject-missing-receipt", 1),
    ],
)
def test_invalid_receipt_inputs_cannot_pass(
    tmp_path: Path,
    scenario: str,
    expected_exit: int,
) -> None:
    """Malformed child status or a missing receipt remains an assertion failure."""
    result = run_cli("preflight", "--scenario", scenario, "--evidence", str(tmp_path / scenario))

    assert result.returncode == expected_exit
    receipt = load_single_receipt(tmp_path / scenario)
    assert receipt.outcome == "assertion_failure"


def test_identity_mismatch_cannot_pass(tmp_path: Path) -> None:
    """A stale source identity is rejected instead of reusing a receipt."""
    expected_identity = tmp_path / "expected-identity.json"
    _ = expected_identity.write_text(json.dumps({"source_sha": "f" * 40}), encoding="utf-8")
    result = run_cli(
        "preflight",
        "--scenario",
        "receipt-fixture",
        "--expected-identity",
        str(expected_identity),
        "--evidence",
        str(tmp_path / "mismatch"),
    )

    assert result.returncode == 1
    receipt = load_single_receipt(tmp_path / "mismatch")
    assert receipt.outcome == "assertion_failure"


def test_repeated_fixture_runs_have_private_run_directories(tmp_path: Path) -> None:
    """Repeated runs produce independent evidence and complete their cleanup."""
    evidence_dir = tmp_path / "repeat"
    first = run_cli("preflight", "--scenario", "receipt-fixture", "--evidence", str(evidence_dir))
    second = run_cli("preflight", "--scenario", "receipt-fixture", "--evidence", str(evidence_dir))
    assert first.returncode == 0
    assert second.returncode == 0

    run_dirs = list(evidence_dir.glob("run-*"))
    assert len(run_dirs) == 2
    assert len({path.name for path in run_dirs}) == 2
    assert all((path / "cleanup.json").is_file() for path in run_dirs)


@pytest.mark.parametrize("delay", [False, True])
def test_child_argv_is_redacted_without_changing_execution(*, delay: bool) -> None:
    import sys

    from supertonic_verify.runner import execute_child

    marker = "SYNTHETIC_SECRET_" + "ARGV"
    script = f"import time; print({marker!r}, flush=True); time.sleep({int(delay)})"
    child = execute_child((sys.executable, "-c", script), 0.1 if delay else 2)
    assert child.outcome == ("timeout" if delay else "success")
    assert marker not in child.model_dump_json()
    assert "***REDACTED***" in " ".join(child.argv)
    if not delay:
        assert "***REDACTED***" in child.stdout


@pytest.mark.parametrize("command", ["preflight", "conformance"])
def test_evidence_file_refused_without_overwriting(tmp_path: Path, command: str) -> None:
    sentinel = tmp_path / "SYNTHETIC_SECRET_DESTINATION"
    original = b"preserve this existing file\n"
    _ = sentinel.write_bytes(original)
    options = (
        ("--scenario", "missing-assets") if command == "preflight" else ("--runtime", "nonexistent")
    )
    result = run_cli(command, *options, "--evidence", str(sentinel))
    assert sentinel.read_bytes() == original
    assert result.returncode == 2
    assert "invalid_invocation" in result.stderr
    assert "Traceback" not in result.stderr
    assert sentinel.name not in result.stderr
    assert len(result.stderr) < 512
