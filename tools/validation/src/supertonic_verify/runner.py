"""Real-process execution and immutable receipt persistence."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import socket
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Final, final

import anyio
from pydantic import ValidationError
from typing_extensions import override

from supertonic_verify.models import (
    ChildExecution,
    CleanupReceipt,
    EvidenceReceipt,
    ExpectedIdentity,
    HostIdentity,
    InputIdentity,
    PortProbe,
)

DIAGNOSTIC_LIMIT: Final = 4096
MODEL_MANIFEST: Final = Path("contracts/v1/models/supertonic-3.json")
SECRET_PATTERN: Final = re.compile(
    r"(?:SYNTHETIC_SECRET_[A-Z0-9_]+|(?i:api[_-]?key|token|secret)\s*[:=]\s*\S+)"
)
SHA256_PATTERN: Final = re.compile(r"^[0-9a-f]{64}$")
SOURCE_IDENTITY_UNAVAILABLE: Final = "repository source identity is unavailable"
MODEL_MANIFEST_UNAVAILABLE: Final = "immutable model manifest is unavailable"
DEPENDENCY_LOCK_UNAVAILABLE: Final = "validation dependency lock is unavailable"
MODEL_REVISION_UNAVAILABLE: Final = "contract model revision is unavailable"
EXPECTED_IDENTITY_INVALID: Final = "expected identity JSON is invalid"


@dataclass(frozen=True, slots=True)
class CommandResult:
    """Represent an exit status and the written receipt path."""

    exit_code: int
    receipt_path: Path


@dataclass(frozen=True, slots=True)
class InvocationError(Exception):
    """Describe a syntactically invalid Q invocation."""

    message: str

    @override
    def __str__(self) -> str:
        """Render the concise public error."""
        return self.message


def repository_root() -> Path:
    """Find the fixed repository root from this installed package."""
    return Path(__file__).resolve().parents[4]


def utc_now() -> str:
    """Return an unambiguous receipt timestamp."""
    return datetime.now(UTC).isoformat()


def sha256_file(path: Path) -> str:
    """Hash an immutable local input without loading it all into memory."""
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


async def _run_process(argv: tuple[str, ...], cwd: Path | None = None) -> tuple[int, str, str]:
    """Run literal argv with AnyIO and return decoded bounded diagnostics."""
    completed = await anyio.run_process(argv, check=False, cwd=cwd)
    return completed.returncode, _decode_output(completed.stdout), _decode_output(completed.stderr)


def git_stdout(root: Path, *arguments: str) -> str:
    """Read one Git identity value through a fixed argv invocation."""
    exit_code, stdout, _ = anyio.run(_run_process, ("git", *arguments), root)
    if exit_code != 0:
        raise InvocationError(SOURCE_IDENTITY_UNAVAILABLE)
    return stdout.strip()


def collect_identity(root: Path) -> InputIdentity:
    """Collect actual source, model, dependency, and host-independent identities."""
    manifest_path = root / MODEL_MANIFEST
    lock_path = root / "tools/validation/uv.lock"
    if not manifest_path.is_file():
        raise InvocationError(MODEL_MANIFEST_UNAVAILABLE)
    if not lock_path.is_file():
        raise InvocationError(DEPENDENCY_LOCK_UNAVAILABLE)
    revision = git_stdout(root, "show", "HEAD:contracts/v1/contract.json")
    return InputIdentity(
        dependency_lock_sha256=sha256_file(lock_path),
        model_manifest_sha256=sha256_file(manifest_path),
        model_revision=_model_revision(revision),
        source_sha=git_stdout(root, "rev-parse", "HEAD"),
        source_worktree_dirty=bool(git_stdout(root, "status", "--porcelain=v1")),
    )


def _model_revision(contract_text: str) -> str:
    """Extract the checked-in revision from trusted contract JSON text."""
    match = re.search(r'"revision"\s*:\s*"([0-9a-f]{40})"', contract_text)
    if match is None:
        raise InvocationError(MODEL_REVISION_UNAVAILABLE)
    return match.group(1)


def collect_host() -> HostIdentity:
    """Collect the actual host and interpreter identity."""
    return HostIdentity(
        hostname=socket.gethostname(),
        machine=platform.machine(),
        os_name=os.name,
        platform=platform.platform(),
        python_version=sys.version,
    )


def redact_and_bound(value: str) -> str:
    """Redact synthetic/secret-like values before retaining bounded diagnostics."""
    redacted = SECRET_PATTERN.sub("***REDACTED***", value)
    if len(redacted) <= DIAGNOSTIC_LIMIT:
        return redacted
    return f"{redacted[:DIAGNOSTIC_LIMIT]}...[truncated]"


def _decode_output(value: bytes | None) -> str:
    """Normalize process output while preserving only safe diagnostics."""
    if value is None:
        return ""
    return redact_and_bound(value.decode("utf-8", errors="replace"))


async def _execute_child_async(argv: tuple[str, ...], timeout_seconds: float) -> ChildExecution:
    """Execute one child with cancellation-enforced timeout semantics."""
    recorded_argv = tuple(redact_and_bound(argument) for argument in argv)
    started = time.perf_counter()
    try:
        with anyio.fail_after(timeout_seconds):
            exit_code, stdout, stderr = await _run_process(argv)
    except TimeoutError:
        return ChildExecution(
            argv=recorded_argv,
            duration_ms=int((time.perf_counter() - started) * 1000),
            exit_code=None,
            outcome="timeout",
            stderr="child exceeded bounded timeout",
            stdout="",
        )
    return ChildExecution(
        argv=recorded_argv,
        duration_ms=int((time.perf_counter() - started) * 1000),
        exit_code=exit_code,
        outcome="success" if exit_code == 0 else "failed",
        stderr=stderr,
        stdout=stdout,
    )


def execute_child(argv: tuple[str, ...], timeout_seconds: float) -> ChildExecution:
    """Run literal argv without a shell and retain the real process status."""
    return anyio.run(_execute_child_async, argv, timeout_seconds)


@final
class EvidenceRun:
    """Own one private run directory, scratch directory, and localhost port."""

    def __init__(self, evidence_dir: Path) -> None:
        """Create a unique run directory under the caller-owned evidence location."""
        self.run_dir: Path = evidence_dir / f"run-{uuid.uuid4().hex}"
        self.run_dir.mkdir(parents=True, exist_ok=False)
        self.scratch_dir: Path = Path(tempfile.mkdtemp(prefix="supertonic-verify-"))
        self.socket: socket.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.bind(("127.0.0.1", 0))
        self.port: int = PortProbe.model_validate({"port": self.socket.getsockname()[1]}).port
        self.resources_path: Path = self.run_dir / "resources.json"
        _ = self.resources_path.write_text(
            json.dumps({"ephemeral_port": self.port, "scratch_dir": str(self.scratch_dir)}) + "\n",
            encoding="utf-8",
        )

    def write_logs(self, children: tuple[ChildExecution, ...]) -> None:
        """Retain redacted child diagnostics as private evidence logs."""
        for index, child in enumerate(children):
            _ = (self.run_dir / f"child-{index}.stdout.log").write_text(
                child.stdout,
                encoding="utf-8",
            )
            _ = (self.run_dir / f"child-{index}.stderr.log").write_text(
                child.stderr,
                encoding="utf-8",
            )

    def cleanup(self) -> CleanupReceipt:
        """Release runtime-only resources and preserve the final cleanup receipt."""
        self.socket.close()
        shutil.rmtree(self.scratch_dir)
        resources_removed = self.resources_path.is_file()
        if resources_removed:
            self.resources_path.unlink()
        cleanup = CleanupReceipt(
            ephemeral_port_released=True,
            resources_file_removed=resources_removed,
            scratch_removed=not self.scratch_dir.exists(),
        )
        cleanup_path = self.run_dir / "cleanup.json"
        _ = cleanup_path.write_text(cleanup.model_dump_json(indent=2) + "\n", encoding="utf-8")
        return cleanup


def assert_expected_identity(
    identity: InputIdentity,
    expected: ExpectedIdentity,
) -> tuple[str, ...]:
    """Reject stale known identities and absent corpus identity explicitly."""
    assertions = (
        ("source", expected.source_sha, identity.source_sha),
        ("model", expected.model_manifest_sha256, identity.model_manifest_sha256),
        ("dependency", expected.dependency_lock_sha256, identity.dependency_lock_sha256),
        ("corpus", expected.corpus_sha256, identity.corpus_sha256),
    )
    return tuple(
        f"{name} identity mismatch"
        for name, wanted, actual in assertions
        if wanted and wanted != actual
    )


def load_expected_identity(path: Path | None) -> ExpectedIdentity:
    """Parse optional caller-supplied identity JSON at the trust boundary."""
    if path is None:
        return ExpectedIdentity()
    try:
        return ExpectedIdentity.model_validate_json(path.read_text(encoding="utf-8"))
    except OSError as error:
        message = f"expected identity file is unavailable: {path}"
        raise InvocationError(message) from error
    except ValidationError as error:
        raise InvocationError(EXPECTED_IDENTITY_INVALID) from error


def write_receipt(run: EvidenceRun, receipt: EvidenceReceipt) -> Path:
    """Write the final canonical receipt after logs and cleanup exist."""
    run.write_logs(receipt.children)
    path = run.run_dir / "receipt.json"
    _ = path.write_text(receipt.model_dump_json(indent=2) + "\n", encoding="utf-8")
    return path


def reject_nonfinite_child_status() -> tuple[str, ...]:
    """Prove strict receipt parsing rejects a non-finite child status."""
    try:
        _ = ChildExecution.model_validate(
            {
                "argv": ["fixture"],
                "duration_ms": 0,
                "exit_code": float("nan"),
                "outcome": "failed",
                "stderr": "",
                "stdout": "",
            }
        )
    except ValidationError:
        return ("non-finite child exit status rejected",)
    return ("non-finite child exit status was accepted",)
