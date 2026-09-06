"""Frozen Pydantic v2 models for validation evidence."""

from __future__ import annotations

from typing import ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt

EvidenceClass = Literal["harness_fixture", "preflight", "rejection"]
Outcome = Literal[
    "verified",
    "assertion_failure",
    "invalid_invocation",
    "missing_prerequisite",
]


class FrozenModel(BaseModel):
    """Make every validation record immutable and reject unknown fields."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)


class HostIdentity(FrozenModel):
    """Identify the host and interpreter that produced one receipt."""

    hostname: str
    machine: str
    os_name: str
    platform: str
    python_version: str


class PortProbe(FrozenModel):
    """Parse the standard-library socket address at its untyped boundary."""

    port: StrictInt = Field(ge=1, le=65535)


class InputIdentity(FrozenModel):
    """Hash every known input and represent unknown corpus data explicitly."""

    dependency_lock_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    model_manifest_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    model_revision: str
    source_sha: str = Field(pattern=r"^[0-9a-f]{40}$")
    source_worktree_dirty: bool
    corpus_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class ExpectedIdentity(FrozenModel):
    """Accept optional identity assertions at the untrusted CLI boundary."""

    dependency_lock_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    model_manifest_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    source_sha: str | None = Field(default=None, pattern=r"^[0-9a-f]{40}$")
    corpus_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class ChildExecution(FrozenModel):
    """Record one child process without interpreting its output as instructions."""

    argv: tuple[str, ...]
    duration_ms: StrictInt = Field(ge=0)
    exit_code: StrictInt | None
    outcome: Literal["success", "failed", "timeout"]
    stderr: str
    stdout: str


class CleanupReceipt(FrozenModel):
    """Prove temporary resources were released after a scenario."""

    ephemeral_port_released: bool
    resources_file_removed: bool
    scratch_removed: bool


class EvidenceReceipt(FrozenModel):
    """Persist a complete, non-reusable validation result."""

    assertion_errors: tuple[str, ...]
    children: tuple[ChildExecution, ...]
    cleanup: CleanupReceipt
    claimable_for: tuple[str, ...]
    command: tuple[str, ...]
    completed_at: str
    evidence_class: EvidenceClass
    ephemeral_port: StrictInt = Field(ge=1, le=65535)
    host: HostIdentity
    identity: InputIdentity
    inference_proof: bool
    outcome: Outcome
    scratch_dir: str
    started_at: str
