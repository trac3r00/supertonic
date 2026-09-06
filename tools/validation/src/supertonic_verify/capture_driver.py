"""Sequential baseline process driver; never invoked by fixture-only protocol tests."""

from __future__ import annotations

import json
import time
from dataclasses import asdict
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar

from pydantic import ConfigDict

from supertonic_verify.capture_program import PROGRAM
from supertonic_verify.capture_protocol import (
    Audio,
    Job,
    Measurement,
    ProcessTiming,
    jobs,
    summarize,
    summarize_processes,
)
from supertonic_verify.models import ChildExecution, FrozenModel
from supertonic_verify.runner import execute_child

if TYPE_CHECKING:
    from collections.abc import Mapping


class Row(FrozenModel):
    """Parse child measurement output before aggregation."""

    synthesis_ns: int
    audio_duration_seconds: float
    rtf: float
    peak_rss_bytes: int
    pcm: Audio


class RuntimeIdentity(FrozenModel):
    """Bind every process to the same actual interpreter and inference dependencies."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="ignore", frozen=True)

    module_sha256: str
    interpreter_sha256: str
    python_version: str
    binding_version: str
    binding_sha256: str
    dependencies: dict[str, str]
    host: dict[str, str | int | None]
    native_binding: tuple[dict[str, str], ...]


class ChildRows(FrozenModel):
    """Read measurement rows without dropping the complete retained child identity."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="ignore", frozen=True)

    rows: tuple[Row, ...]
    load_ns: int


def capture_processes(
    checkout: Path, cache: Path, run_dir: Path, snapshot: Mapping[str, str]
) -> tuple[ChildExecution, ...]:
    """Sync once outside measurement, then spawn fresh interpreters per protocol job."""
    sync = execute_child(
        ("uv", "sync", "--project", str(checkout / "py"), "--frozen", "--python", "3.13.14"),
        300,
    )
    children = [sync]
    if sync.exit_code != 0:
        return tuple(children)
    script = run_dir / "capture-child.py"
    _ = script.write_text(PROGRAM, encoding="utf-8")
    executable = checkout / "py/.venv/bin/python"
    grouped: dict[str, list[Measurement]] = {}
    identity: RuntimeIdentity | None = None
    process_groups: dict[str, list[ProcessTiming]] = {}
    for job in jobs():
        output = run_dir / job.name
        started = time.perf_counter_ns()
        child = execute_child(
            (
                str(executable),
                "-I",
                str(script),
                str(checkout / "py"),
                str(cache),
                str(output),
                str(Path(__file__).parent),
                json.dumps(asdict(job)),
                snapshot["helper_sha256"],
            ),
            1800,
        )
        process_ns = time.perf_counter_ns() - started
        children.append(child)
        _ = (run_dir / f"{job.name}-process.json").write_text(
            json.dumps(
                {"process_launch_to_exit_ns": process_ns, "child": child.model_dump()}, indent=2
            )
            + "\n",
            encoding="utf-8",
        )
        if child.exit_code != 0:
            return tuple(children)
        raw = (output / "child.json").read_text(encoding="utf-8")
        observed = RuntimeIdentity.model_validate_json(raw)
        if observed.module_sha256 != snapshot["helper_sha256"]:
            message = "child source identity differs from original snapshot"
            raise ValueError(message)
        if identity is not None and observed != identity:
            message = "baseline runtime/host identity changed between processes"
            raise ValueError(message)
        identity = observed
        metadata = ChildRows.model_validate_json(raw)
        rows = metadata.rows
        if len(rows) != job.requests:
            message = "child returned an incomplete measurement population"
            raise ValueError(message)
        key = f"{job.workload}-r{job.repeat}-{job.mode}"
        process_groups.setdefault(key, []).append(ProcessTiming(process_ns, metadata.load_ns))
        grouped.setdefault(key, []).extend(
            Measurement(
                row.synthesis_ns, row.audio_duration_seconds, row.rtf, row.peak_rss_bytes, row.pcm
            )
            for row in rows
        )
    _ = (run_dir / "capture-summary.json").write_text(
        json.dumps({key: asdict(summarize(rows)) for key, rows in grouped.items()}, indent=2)
        + "\n",
        encoding="utf-8",
    )
    _ = (run_dir / "capture-process-summary.json").write_text(
        json.dumps(
            {key: asdict(summarize_processes(rows)) for key, rows in process_groups.items()},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return tuple(children)


def smoke_process(checkout: Path, cache: Path, run_dir: Path, helper_digest: str) -> ChildExecution:
    """Exercise the actual capture worker once; environment setup is outside its clock."""
    sync = execute_child(
        ("uv", "sync", "--project", str(checkout / "py"), "--frozen", "--python", "3.13.14"),
        300,
    )
    _ = (run_dir / "environment-sync.json").write_text(sync.model_dump_json(indent=2) + "\n")
    if sync.exit_code != 0:
        return sync
    script = run_dir / "capture-child.py"
    _ = script.write_text(PROGRAM, encoding="utf-8")
    started = time.perf_counter_ns()
    child = execute_child(
        (
            str(checkout / "py/.venv/bin/python"),
            "-I",
            str(script),
            str(checkout / "py"),
            str(cache),
            str(run_dir / "reference"),
            str(Path(__file__).parent),
            json.dumps(asdict(Job("short", 0, "cold", 0, 1, 0))),
            helper_digest,
            "prepare",
        ),
        300,
    )
    elapsed = time.perf_counter_ns() - started
    _ = (run_dir / "smoke-process.json").write_text(
        json.dumps({"process_launch_to_exit_ns": elapsed, "measurement_class": "preparation"})
        + "\n"
    )
    return child
