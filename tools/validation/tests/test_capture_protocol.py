"""Synthetic scheduling and arithmetic tests, never performance measurements."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from supertonic_verify.capture_protocol import Measurement, Summary


def test_capture_protocol_has_an_executable_unit_seam() -> None:
    path = Path(__file__).parents[1] / "src/supertonic_verify/capture_protocol.py"
    assert path.is_file(), "capture scheduling/measurement implementation is absent"
    assert importlib.util.spec_from_file_location("capture_protocol", path) is not None


def test_exact_counts_and_real_warm_order_on_one_engine() -> None:
    from supertonic_verify.capture_protocol import Audio, jobs, measure, measurement

    plan = jobs()
    assert len(plan) == 36
    assert sum(job.requests for job in plan) == 207
    assert sum(job.warmups for job in plan) == 9
    assert len({job.name for job in plan}) == 36
    for workload in ("short", "medium", "long"):
        for repeat in range(3):
            selected = [job for job in plan if job.workload == workload and job.repeat == repeat]
            assert [job.requests for job in selected] == [1, 1, 1, 20]
            assert [job.warmups for job in selected] == [0, 0, 0, 1]
    calls: list[int] = []

    def request(index: int) -> Measurement:
        calls.append(index)
        return measurement(1_000_000_000, Audio(88_200, 44_100, "fixture", "fixture"), 1024)

    rows = measure(plan[3], request)
    assert calls == [-1, *range(20)]
    assert len(rows) == 20


def test_units_and_nearest_rank_summary() -> None:
    from supertonic_verify.capture_protocol import Audio, measurement, rss_bytes, summarize

    audio = Audio(88_200, 44_100, "synthetic-not-performance", "fixture")
    rows = [measurement(index * 1_000_000_000, audio, index * 1024) for index in range(1, 21)]
    summary = summarize(rows)
    assert rows[0].audio_duration_seconds == 2.0
    assert rows[0].rtf == 0.5
    assert summary.latency_p50_ns == 10_000_000_000
    assert summary.latency_p95_ns == 19_000_000_000
    assert summary.rtf_p95 == 9.5
    assert summary.peak_rss_bytes == 20_480
    assert rss_bytes(1234, "darwin") == 1234
    assert rss_bytes(1234, "linux") == 1_263_616


def test_committed_control_definition_is_lossless() -> None:
    import anyio

    from supertonic_verify.baseline import CONTROL_REF
    from supertonic_verify.runner import repository_root

    async def read_blob() -> bytes:
        result = await anyio.run_process(
            (
                "git",
                "-C",
                str(repository_root()),
                "show",
                f"{CONTROL_REF}:contracts/v1/dependencies.json",
            )
        )
        return result.stdout

    original = anyio.run(read_blob)
    from supertonic_verify.baseline import git_text

    assert (
        git_text(repository_root(), "show", f"{CONTROL_REF}:contracts/v1/dependencies.json") + "\n"
    ).encode() == original


def test_driver_orchestrates_complete_synthetic_protocol(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import json
    from dataclasses import asdict

    from pydantic import TypeAdapter

    from supertonic_verify import capture_driver
    from supertonic_verify.capture_protocol import Audio, Job, measure, measurement
    from supertonic_verify.models import ChildExecution

    calls: list[tuple[str, ...]] = []
    requests: list[tuple[str, int]] = []

    def fixture_child(argv: tuple[str, ...], timeout_seconds: float) -> ChildExecution:
        assert timeout_seconds > 0
        calls.append(argv)
        if argv[0] != "uv":
            job = TypeAdapter(Job).validate_json(argv[7])
            output = Path(argv[5])
            output.mkdir()

            def request(index: int) -> Measurement:
                requests.append((job.name, index))
                return measurement(1_000_000, Audio(44_100, 44_100, "fixture", "fixture"), 2048)

            rows = measure(job, request)
            _ = (output / "child.json").write_text(
                json.dumps(
                    {
                        "rows": [asdict(row) for row in rows],
                        "load_ns": 100,
                        "evidence_class": "synthetic_non_performance_fixture",
                        "module_sha256": "fixture",
                        "interpreter_sha256": "fixture",
                        "python_version": "fixture",
                        "binding_version": "fixture",
                        "binding_sha256": "fixture",
                        "dependencies": {},
                        "host": {},
                        "native_binding": [],
                    }
                )
            )
        return ChildExecution(
            argv=argv, duration_ms=1, exit_code=0, outcome="success", stderr="", stdout="fixture"
        )

    monkeypatch.setattr(capture_driver, "execute_child", fixture_child)
    children = capture_driver.capture_processes(
        tmp_path / "source", tmp_path / "cache", tmp_path, {"helper_sha256": "fixture"}
    )
    assert len(children) == len(calls) == 37
    assert len(requests) == 216
    assert sum(index == -1 for _, index in requests) == 9
    assert all(call[1] == "-I" for call in calls[1:])
    summaries = TypeAdapter(dict[str, Summary]).validate_json(
        (tmp_path / "capture-summary.json").read_text()
    )
    assert len(summaries) == 18
    assert sum(value.count for value in summaries.values()) == 207
    assert all(
        value.count == (20 if key.endswith("warm") else 3) for key, value in summaries.items()
    )


def test_child_program_compiles_and_invalid_units_fail() -> None:
    from supertonic_verify.capture_program import PROGRAM
    from supertonic_verify.capture_protocol import Audio, measurement, rss_bytes, summarize

    _ = compile(PROGRAM, "capture-child.py", "exec")
    with pytest.raises(ValueError, match="invalid synthesis"):
        _ = measurement(-1, Audio(1, 44_100, "fixture", "fixture"), 0)
    with pytest.raises(ValueError, match="invalid synthesis"):
        _ = measurement(1, Audio(0, 44_100, "fixture", "fixture"), 0)
    with pytest.raises(ValueError, match="unqualified"):
        _ = rss_bytes(10, "win32")
    with pytest.raises(ValueError, match="empty"):
        _ = summarize(())


def test_process_totals_are_not_confused_with_synthesis_latency() -> None:
    from supertonic_verify.capture_protocol import ProcessTiming, summarize_processes

    summary = summarize_processes(
        (ProcessTiming(9000, 6000), ProcessTiming(7000, 4000), ProcessTiming(8000, 5000))
    )
    assert summary.process_p50_ns == 8000
    assert summary.process_p95_ns == 9000
    assert summary.load_p50_ns == 5000
    assert summary.load_p95_ns == 6000


def test_driver_stops_on_failed_child_without_aggregate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from supertonic_verify import capture_driver
    from supertonic_verify.models import ChildExecution

    calls: list[tuple[str, ...]] = []

    def fixture_child(argv: tuple[str, ...], timeout_seconds: float) -> ChildExecution:
        assert timeout_seconds > 0
        calls.append(argv)
        failed = argv[0] != "uv"
        return ChildExecution(
            argv=argv,
            duration_ms=0,
            exit_code=23 if failed else 0,
            outcome="failed" if failed else "success",
            stderr="synthetic worker failure" if failed else "",
            stdout="",
        )

    monkeypatch.setattr(capture_driver, "execute_child", fixture_child)
    children = capture_driver.capture_processes(
        tmp_path / "source", tmp_path / "cache", tmp_path, {"helper_sha256": "fixture"}
    )
    assert len(children) == len(calls) == 2
    assert children[-1].exit_code == 23
    assert not (tmp_path / "capture-summary.json").exists()
