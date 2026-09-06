"""Immutable original-source baseline preparation primitives."""

from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar, Final, Literal

import anyio
from pydantic import ConfigDict, Field, StrictInt

from .capture_driver import capture_processes, smoke_process
from .capture_protocol import jobs
from .models import ChildExecution, FrozenModel
from .runner import execute_child

if TYPE_CHECKING:
    from collections.abc import Mapping

ORIGINAL_REF: Final = "104e2ec154823b0e296076f98016de9b3b41cfe5"
CONTROL_REF: Final = "1058e9192f410f1409c36dcd12faedac43fe9e1f"
CONTROL_DEPENDENCIES_PATH: Final = Path("contracts/v1/dependencies.json")
MODEL_CACHE_PATH: Final = Path(
    ".omo/evidence/task-2/cache/supertonic-3/724fb5abbf5502583fb520898d45929e62f02c0b"
)
MODEL_ID: Final = "supertonic-3"
MODEL_REVISION: Final = "724fb5abbf5502583fb520898d45929e62f02c0b"
SAMPLE_RATE: Final = 44_100
MANIFEST_FILE: Final = "manifest.json"
MODEL_MANIFEST_SHA256: Final = "1b781c821806d3243a95af38033cc6ade0f21b81196b52800b4cd50a0d7042fe"
SMOKE_SCRIPT_NAME: Final = "reference_smoke.py"
MODEL_MANIFEST_INVALID: Final = "model manifest is unavailable or invalid"
MODEL_IDENTITY_MISMATCH: Final = "model manifest identity does not match required cached model"
MODEL_ASSET_UNAVAILABLE: Final = "manifest asset is unavailable"
MODEL_ASSET_ESCAPE: Final = "manifest asset escapes cache"
MODEL_ASSET_MISMATCH: Final = "manifest asset hash mismatch"
SNAPSHOT_CHECKOUT_FAILED: Final = "original source checkout could not be created"
SNAPSHOT_ARCHIVE_FAILED: Final = "original source archive could not be created"
SMOKE_IMPORT_ESCAPE: Final = "smoke imported helper outside original source checkout"
SMOKE_DIGEST_MISMATCH: Final = "smoke helper digest does not match original source snapshot"
SMOKE_AUDIO_FORMAT: Final = "smoke output is not mono at the manifest sample rate"
SMOKE_AUDIO_INVALID: Final = "smoke output is not finite ordinary-speech PCM"
GIT_READ_FAILED: Final = "immutable Git source could not be read"
SUBSTITUTION_FIXTURE_INVALID: Final = "model manifest cannot stage a substituted-file fixture"


class BaselineError(Exception):
    """Describe one invalid immutable baseline input."""


class CachedModel(FrozenModel):
    """Parse the immutable cache model identity."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="ignore", frozen=True)

    id: str
    revision: str
    sample_rate: StrictInt = Field(alias="sampleRate")


class CachedFile(FrozenModel):
    """Parse one manifest-listed cache file."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="ignore", frozen=True)

    path: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class CacheManifest(FrozenModel):
    """Parse the model cache manifest used by the original reference."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="ignore", frozen=True)

    model: CachedModel
    files: tuple[CachedFile, ...]


class SmokeMetadata(FrozenModel):
    """Validate the child-produced original-runtime reference facts."""

    all_zero: bool
    binding_file: str
    binding_version: str
    channels: StrictInt
    finite: bool
    intermediate_mask_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    intermediate_noise_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    interpreter: str
    interpreter_version: str
    module_file: str
    module_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    pcm_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    peak_rss_bytes: StrictInt = Field(ge=0)
    process_wall_clock_ns: StrictInt = Field(ge=0)
    sample_count: StrictInt = Field(gt=0)
    sample_rate: StrictInt
    synthesis_wall_clock_ns: StrictInt = Field(ge=0)
    load_wall_clock_ns: StrictInt = Field(ge=0)


@dataclass(frozen=True, slots=True)
class BaselineResult:
    """Return a truthful baseline scenario conclusion to the CLI adapter."""

    children: tuple[ChildExecution, ...]
    errors: tuple[str, ...]
    evidence_class: Literal["baseline_preparation", "baseline_capture", "rejection"]
    outcome: Literal["verified", "invalid_invocation", "assertion_failure"]
    inference_proof: bool


def sha256_file(path: Path) -> str:
    """Hash one file without retaining its content in memory."""
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def prepare(root: Path, ref: str, run_dir: Path, scratch_dir: Path) -> BaselineResult:
    """Materialize and smoke the exact original source without benchmarking it."""
    if ref != ORIGINAL_REF:
        return _invalid_ref_result(ref)
    cache_root = root / MODEL_CACHE_PATH
    try:
        manifest = validate_cache(cache_root)
        checkout = run_dir / "original-source-checkout"
        snapshot = _create_snapshot(root, checkout, run_dir)
        _write_control_definition(root, run_dir)
        smoke = _run_smoke(checkout, cache_root, run_dir, scratch_dir)
        if smoke.outcome != "success":
            return BaselineResult(
                children=(smoke,),
                errors=("original source smoke synthesis failed",),
                evidence_class="baseline_preparation",
                outcome="assertion_failure",
                inference_proof=False,
            )
        metadata = SmokeMetadata.model_validate_json(
            (run_dir / "reference" / "smoke.json").read_text(encoding="utf-8")
        )
        _validate_smoke(metadata, checkout, snapshot, manifest)
    except (BaselineError, OSError, ValueError) as error:
        return BaselineResult(
            children=(),
            errors=(str(error),),
            evidence_class="baseline_preparation",
            outcome="assertion_failure",
            inference_proof=False,
        )
    finally:
        _remove_checkout(root, run_dir / "original-source-checkout", run_dir)
    return BaselineResult(
        children=(smoke,),
        errors=(),
        evidence_class="baseline_preparation",
        outcome="verified",
        inference_proof=True,
    )


def capture(root: Path, ref: str, run_dir: Path, scratch_dir: Path) -> BaselineResult:
    """Run the complete baseline protocol only on an explicit capture dispatch."""
    if ref != ORIGINAL_REF:
        return _invalid_ref_result(ref)
    checkout = run_dir / "original-source-checkout"
    children: tuple[ChildExecution, ...] = ()
    errors: tuple[str, ...] = ()
    try:
        _ = validate_cache(root / MODEL_CACHE_PATH)
        snapshot = _create_snapshot(root, checkout, run_dir)
        _write_control_definition(root, run_dir)
        children = capture_processes(checkout, root / MODEL_CACHE_PATH, run_dir, snapshot)
        _ = validate_cache(root / MODEL_CACHE_PATH)
        if len(children) != len(jobs()) + 1 or any(child.exit_code != 0 for child in children):
            errors = ("baseline capture protocol did not finish every process",)
    except (BaselineError, OSError, ValueError) as error:
        errors = (str(error),)
    finally:
        _remove_checkout(root, checkout, run_dir)
    _write_json(scratch_dir / "capture-finished.json", {"finished": not errors})
    return BaselineResult(
        children=children,
        errors=errors,
        evidence_class="baseline_capture",
        outcome="assertion_failure" if errors else "verified",
        inference_proof=not errors,
    )


def reject_mismatched_assets(root: Path, ref: str, scratch_dir: Path) -> BaselineResult:
    """Prove a scratch-only substituted cache manifest cannot validate."""
    if ref != ORIGINAL_REF:
        return _invalid_ref_result(ref)
    source = root / MODEL_CACHE_PATH / MANIFEST_FILE
    mutated = scratch_dir / "substituted-manifest.json"
    try:
        _ = validate_cache(root / MODEL_CACHE_PATH)
        _stage_substituted_manifest(source, mutated)
        _ = validate_cache(root / MODEL_CACHE_PATH, mutated)
    except BaselineError:
        return BaselineResult(
            children=(),
            errors=(),
            evidence_class="rejection",
            outcome="verified",
            inference_proof=False,
        )
    except (OSError, json.JSONDecodeError) as error:
        return BaselineResult(
            children=(),
            errors=(str(error),),
            evidence_class="rejection",
            outcome="assertion_failure",
            inference_proof=False,
        )
    return BaselineResult(
        children=(),
        errors=("substituted model manifest was accepted",),
        evidence_class="rejection",
        outcome="assertion_failure",
        inference_proof=False,
    )


def validate_cache(cache_root: Path, manifest_path: Path | None = None) -> CacheManifest:
    """Verify cache identity and every manifest-listed file hash."""
    selected_manifest = cache_root / MANIFEST_FILE if manifest_path is None else manifest_path
    if sha256_file(selected_manifest) != MODEL_MANIFEST_SHA256:
        raise _error(MODEL_IDENTITY_MISMATCH)
    try:
        manifest = CacheManifest.model_validate_json(selected_manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise _error(MODEL_MANIFEST_INVALID) from error
    if (
        manifest.model.id != MODEL_ID
        or manifest.model.revision != MODEL_REVISION
        or manifest.model.sample_rate != SAMPLE_RATE
    ):
        raise _error(MODEL_IDENTITY_MISMATCH)
    for entry in manifest.files:
        candidate = cache_root / entry.path
        try:
            resolved = candidate.resolve(strict=True)
        except OSError as error:
            raise _asset_error(MODEL_ASSET_UNAVAILABLE, entry.path) from error
        if (
            candidate.is_symlink()
            or not resolved.is_file()
            or not resolved.is_relative_to(cache_root.resolve())
        ):
            raise _asset_error(MODEL_ASSET_ESCAPE, entry.path)
        if sha256_file(candidate) != entry.sha256:
            raise _asset_error(MODEL_ASSET_MISMATCH, entry.path)
    return manifest


def _invalid_ref_result(ref: str) -> BaselineResult:
    """Reject an attempt to relabel any revision as the original baseline."""
    return BaselineResult(
        children=(),
        errors=(f"baseline ref must equal immutable original {ORIGINAL_REF}, got {ref}",),
        evidence_class="rejection",
        outcome="invalid_invocation",
        inference_proof=False,
    )


def _create_snapshot(root: Path, checkout: Path, run_dir: Path) -> dict[str, str]:
    """Create an exact detached worktree and retained archive digest."""
    add = _run(("git", "-C", str(root), "worktree", "add", "--detach", str(checkout), ORIGINAL_REF))
    if add.outcome != "success":
        raise _error(SNAPSHOT_CHECKOUT_FAILED)
    archive = run_dir / "original-source.tar"
    archived = _run(
        ("git", "-C", str(root), "archive", "--format=tar", "-o", str(archive), ORIGINAL_REF)
    )
    if archived.outcome != "success":
        raise _error(SNAPSHOT_ARCHIVE_FAILED)
    tree = git_text(root, "rev-parse", f"{ORIGINAL_REF}^{{tree}}")
    helper = checkout / "py" / "helper.py"
    lock = checkout / "py" / "uv.lock"
    snapshot = {
        "archive_sha256": sha256_file(archive),
        "helper_sha256": sha256_file(helper),
        "original_ref": ORIGINAL_REF,
        "py_uv_lock_sha256": sha256_file(lock),
        "tree_sha": tree,
    }
    _write_json(run_dir / "source-snapshot.json", snapshot)
    return snapshot


def _write_control_definition(root: Path, run_dir: Path) -> None:
    """Persist the exact independent control dependency definition."""
    content = git_text(root, "show", f"{CONTROL_REF}:{CONTROL_DEPENDENCIES_PATH}")
    for filename in ("pyproject.toml", "uv.lock"):
        _ = (run_dir / f"control-{filename}").write_bytes(
            anyio.run(_read_git, root, ("show", f"{CONTROL_REF}:py/{filename}"))
        )
    _ = (run_dir / "verified-model-manifest.json").write_bytes(
        (root / MODEL_CACHE_PATH / MANIFEST_FILE).read_bytes()
    )
    _write_json(
        run_dir / "dependency-tracks.json",
        {
            "executed_track": "historical original py/uv.lock, frozen",
            "control_track": "committed definitions only; not executed or measured",
            "comparison_policy": "no dependency/precision changes attributed to code-only speedup",
            "control_pyproject_sha256": sha256_file(run_dir / "control-pyproject.toml"),
            "control_lock_sha256": sha256_file(run_dir / "control-uv.lock"),
        },
    )
    target = run_dir / "control-dependencies.json"
    _ = target.write_text(content + "\n", encoding="utf-8")
    _write_json(
        run_dir / "control-dependencies-identity.json",
        {
            "control_commit": CONTROL_REF,
            "path": str(CONTROL_DEPENDENCIES_PATH),
            "sha256": sha256_file(target),
        },
    )


def _run_smoke(
    checkout: Path,
    cache_root: Path,
    run_dir: Path,
    scratch_dir: Path,
) -> ChildExecution:
    """Execute one original-runtime smoke synthesis with fixed noise."""
    _write_json(scratch_dir / "smoke-started.json", {"phase": "preparation"})
    return smoke_process(checkout, cache_root, run_dir, sha256_file(checkout / "py/helper.py"))


def _validate_smoke(
    metadata: SmokeMetadata,
    checkout: Path,
    snapshot: dict[str, str],
    manifest: CacheManifest,
) -> None:
    """Reject stale/module-mismatched or invalid real-audio smoke artifacts."""
    if Path(metadata.module_file).resolve() != (checkout / "py" / "helper.py").resolve():
        raise _error(SMOKE_IMPORT_ESCAPE)
    if metadata.module_sha256 != snapshot["helper_sha256"]:
        raise _error(SMOKE_DIGEST_MISMATCH)
    if metadata.sample_rate != manifest.model.sample_rate or metadata.channels != 1:
        raise _error(SMOKE_AUDIO_FORMAT)
    if not metadata.finite or metadata.all_zero:
        raise _error(SMOKE_AUDIO_INVALID)


def _remove_checkout(root: Path, checkout: Path, run_dir: Path) -> None:
    """Remove the evidence checkout and retain an explicit cleanup receipt."""
    removed = False
    if checkout.exists():
        remove = _run(("git", "-C", str(root), "worktree", "remove", "--force", str(checkout)))
        removed = remove.outcome == "success"
        if checkout.exists():
            shutil.rmtree(checkout)
            removed = not checkout.exists()
    _write_json(run_dir / "baseline-cleanup.json", {"source_checkout_removed": removed})


def git_text(root: Path, *arguments: str) -> str:
    """Run one fixed Git read command and return its nonempty stdout."""
    return anyio.run(_read_git, root, arguments).decode("utf-8").rstrip("\n")


async def _read_git(root: Path, arguments: tuple[str, ...]) -> bytes:
    """Read immutable source bytes losslessly, never via bounded diagnostic logs."""
    result = await anyio.run_process(("git", "-C", str(root), *arguments), check=False)
    if result.returncode != 0 or not result.stdout:
        raise _error(GIT_READ_FAILED)
    return result.stdout


def _run(argv: tuple[str, ...]) -> ChildExecution:
    """Run a literal child process and retain bounded diagnostic-free status."""
    return execute_child(argv, 300)


def _write_json(path: Path, value: Mapping[str, str | bool]) -> None:
    """Write one compact deterministic JSON evidence record."""
    _ = path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _error(message: str) -> BaselineError:
    """Construct the typed baseline error outside control-flow branches."""
    return BaselineError(message)


def _asset_error(reason: str, path: str) -> BaselineError:
    """Construct a typed cache-asset error with the exact manifest path."""
    return BaselineError(f"{reason}: {path}")


def _stage_substituted_manifest(source: Path, target: Path) -> None:
    """Write one scratch-only cache manifest with a known-invalid listed hash."""
    manifest = CacheManifest.model_validate_json(source.read_text(encoding="utf-8"))
    if not manifest.files:
        raise _error(SUBSTITUTION_FIXTURE_INVALID)
    first = manifest.files[0].model_copy(update={"sha256": "0" * 64})
    substituted = manifest.model_copy(update={"files": (first, *manifest.files[1:])})
    _ = target.write_text(substituted.model_dump_json(by_alias=True), encoding="utf-8")
