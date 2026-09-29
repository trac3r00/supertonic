"""Pure scheduling and measurement math shared by isolated baseline children."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

SAMPLE_RATE: Final = 44_100

WORKLOADS: Final = {
    "short": "This is a fixed baseline speech sample.",
    "medium": (
        "This morning the team reviewed the results and discussed the next steps. "
        "We will keep the voice, language, speed, and model unchanged for every request."
    ),
    "long": (
        "This morning the team reviewed the results and discussed the next steps. "
        "We will keep the voice, language, speed, and model unchanged for every request. "
    )
    * 8,
}


@dataclass(frozen=True, slots=True)
class Job:
    """One fresh process; warm jobs retain one model for warmup plus twenty requests."""

    workload: str
    repeat: int
    mode: Literal["cold", "warm"]
    index: int
    requests: int
    warmups: int

    @property
    def name(self) -> str:
        """Return a unique artifact stem across the complete protocol."""
        return f"{self.workload}-r{self.repeat}-{self.mode}-{self.index}"


def jobs() -> tuple[Job, ...]:
    """Plan three cold processes and one twenty-request warm process per repeat."""
    return tuple(
        job
        for workload in WORKLOADS
        for repeat in range(3)
        for job in (
            *(Job(workload, repeat, "cold", index, 1, 0) for index in range(3)),
            Job(workload, repeat, "warm", 0, 20, 1),
        )
    )


@dataclass(frozen=True, slots=True)
class Audio:
    """Describe an already retained mono PCM output."""

    samples: int
    sample_rate: int
    path: str
    sha256: str


@dataclass(frozen=True, slots=True)
class Measurement:
    """Separate synthesis-only latency from PCM persistence and process lifetime."""

    synthesis_ns: int
    audio_duration_seconds: float
    rtf: float
    peak_rss_bytes: int
    pcm: Audio


def rss_bytes(raw: int, platform: str) -> int:
    """Normalize getrusage high-water RSS: bytes on Darwin, KiB on Linux."""
    if platform not in {"darwin", "linux"}:
        message = "getrusage RSS units are unqualified on this platform"
        raise ValueError(message)
    return raw if platform == "darwin" else raw * 1024


def measure(job: Job, request: Callable[[int], Measurement]) -> tuple[Measurement, ...]:
    """Run excluded warmups first, then measured requests on the caller's one engine."""
    for index in range(job.warmups):
        _ = request(-index - 1)
    return tuple(request(index) for index in range(job.requests))


def measurement(synthesis_ns: int, audio: Audio, peak_rss_bytes: int) -> Measurement:
    """Convert nanoseconds and valid sample counts without using predicted duration."""
    if synthesis_ns < 0 or audio.samples <= 0 or audio.sample_rate != SAMPLE_RATE:
        message = "invalid synthesis time or mono 44.1kHz PCM metadata"
        raise ValueError(message)
    duration = audio.samples / audio.sample_rate
    return Measurement(synthesis_ns, duration, synthesis_ns / 1e9 / duration, peak_rss_bytes, audio)


@dataclass(frozen=True, slots=True)
class Summary:
    """Nearest-rank percentiles with explicit population and RSS high-water semantics."""

    count: int
    latency_p50_ns: int
    latency_p95_ns: int
    rtf_p50: float
    rtf_p95: float
    peak_rss_bytes: int
    percentile_method: str = "nearest-rank; warmups excluded; no cross-workload pooling"


def summarize(rows: Sequence[Measurement]) -> Summary:
    """Aggregate a single workload/mode/repeat without mixing startup and warm latency."""
    if not rows:
        message = "cannot summarize empty measurements"
        raise ValueError(message)
    latency = sorted(row.synthesis_ns for row in rows)
    rtf = sorted(row.rtf for row in rows)
    middle, tail = math.ceil(len(rows) * 0.5) - 1, math.ceil(len(rows) * 0.95) - 1
    return Summary(
        len(rows),
        latency[middle],
        latency[tail],
        rtf[middle],
        rtf[tail],
        max(row.peak_rss_bytes for row in rows),
    )


@dataclass(frozen=True, slots=True)
class ProcessTiming:
    """Keep environment setup separate from fresh-process and model-load measurements."""

    process_launch_to_exit_ns: int
    load_ns: int


@dataclass(frozen=True, slots=True)
class ProcessSummary:
    """Summarize process totals, which include serialization rather than just inference."""

    count: int
    process_p50_ns: int
    process_p95_ns: int
    load_p50_ns: int
    load_p95_ns: int


def summarize_processes(rows: Sequence[ProcessTiming]) -> ProcessSummary:
    """Report nearest-rank process and load percentiles for one workload/mode/repeat."""
    if not rows:
        message = "cannot summarize empty process measurements"
        raise ValueError(message)
    process = sorted(row.process_launch_to_exit_ns for row in rows)
    load = sorted(row.load_ns for row in rows)
    middle, tail = math.ceil(len(rows) * 0.5) - 1, math.ceil(len(rows) * 0.95) - 1
    return ProcessSummary(len(rows), process[middle], process[tail], load[middle], load[tail])
