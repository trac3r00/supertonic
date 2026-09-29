"""CLI adapter for immutable original-model baseline preparation."""

from __future__ import annotations

from typing import TYPE_CHECKING

from supertonic_verify.baseline import BaselineResult, capture, prepare, reject_mismatched_assets

if TYPE_CHECKING:
    from pathlib import Path


def run(root: Path, ref: str, scenario: str, run_dir: Path, scratch_dir: Path) -> BaselineResult:
    """Dispatch one explicit task4A scenario without simulating benchmark completion."""
    run_dir = run_dir.resolve()
    match scenario:
        case "capture":
            return capture(root, ref, run_dir, scratch_dir)
        case "prepare":
            return prepare(root, ref, run_dir, scratch_dir)
        case "reject-mismatched-assets":
            return reject_mismatched_assets(root, ref, scratch_dir)
        case _:
            return BaselineResult(
                children=(),
                errors=(f"baseline scenario {scenario!r} is not implemented",),
                evidence_class="rejection",
                outcome="invalid_invocation",
                inference_proof=False,
            )
