"""Isolated child program using the immutable helper and the shared protocol arithmetic."""

from typing import Final

PROGRAM: Final = r"""
import time
entered_ns = time.perf_counter_ns()
import sys
import json
import hashlib
import importlib.metadata
import os
import platform
import resource
from dataclasses import asdict
from pathlib import Path

source, cache, output, protocol_path, job_json, expected_digest = sys.argv[1:7]
source, cache, output = Path(source).resolve(), Path(cache).resolve(), Path(output).resolve()
sys.path.insert(0, protocol_path)
from capture_protocol import Job, WORKLOADS, Audio, measure, measurement, rss_bytes
sys.path.pop(0)
sys.path.insert(0, str(source))
import helper
import numpy as np
import onnxruntime as ort
import soundfile as sf

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

module = Path(helper.__file__).resolve()
if module != source / "helper.py" or digest(module) != expected_digest:
    raise RuntimeError("original helper identity mismatch")
job = Job(**json.loads(job_json))
output.mkdir(parents=True, exist_ok=False)
load_started = time.perf_counter_ns()
tts = helper.load_text_to_speech(str(cache / "onnx"))
style = helper.load_voice_style([str(cache / "voice_styles/M1.json")])
load_ns = time.perf_counter_ns() - load_started
sessions = [tts.dp_ort, tts.text_enc_ort, tts.vector_est_ort, tts.vocoder_ort]
if any(session.get_providers() != ["CPUExecutionProvider"] for session in sessions):
    raise RuntimeError("unexpected execution provider")
original_sample = tts.sample_noisy_latent
captured = []
request_events = []

def sample(duration):
    noise, mask = original_sample(duration)
    captured.append((noise.copy(), mask.copy()))
    return noise, mask

tts.sample_noisy_latent = sample

def request(index):
    captured.clear()
    np.random.seed(41024)
    started = time.perf_counter_ns()
    wav, duration = tts(WORKLOADS[job.workload], "en", style, 8, 1.05)
    ready_ns = time.perf_counter_ns()
    synthesis_ns = ready_ns - started
    request_events.append({"index": index, "measured": index >= 0,
        "entry_to_pcm_ready_ns": ready_ns - entered_ns,
        "synthesis_start_since_entry_ns": started - entered_ns})
    count = int(tts.sample_rate * duration[0].item())
    pcm = np.asarray(wav[0, :count], dtype=np.float32)
    if tts.sample_rate != 44100 or pcm.ndim != 1 or pcm.size == 0:
        raise RuntimeError("invalid PCM layout")
    if not np.isfinite(pcm).all() or not np.any(pcm):
        raise RuntimeError("nonfinite or all-zero PCM")
    peak = rss_bytes(int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss), sys.platform)
    stem = "warmup" if index < 0 else f"request-{index:02}"
    target = output / f"{stem}.npy"
    np.save(target, pcm, allow_pickle=False)
    sf.write(output / f"{stem}.wav", pcm, 44100, subtype="FLOAT")
    decoded, rate = sf.read(output / f"{stem}.wav", dtype="float32")
    if rate != 44100 or not np.array_equal(decoded, pcm):
        raise RuntimeError("decoded audio differs from reference PCM")
    for chunk, (noise, mask) in enumerate(captured):
        np.save(output / f"{stem}-chunk-{chunk}-noise.npy", noise, allow_pickle=False)
        np.save(output / f"{stem}-chunk-{chunk}-mask.npy", mask, allow_pickle=False)
    return measurement(synthesis_ns, Audio(int(pcm.size), 44100, str(target), digest(target)), peak)

rows = measure(job, request)
result = {
    "job": asdict(job), "rows": [asdict(row) for row in rows],
    "request_events": request_events,
    "measurement_metadata": {
        "clock": "time.perf_counter_ns; monotonic nanoseconds",
        "process_cold": "fresh interpreter; filesystem/OS caches not flushed",
        "warm": "one excluded synthesis then 20 requests on the same loaded engine",
        "process_lifetime": "launch to exit including serialization; environment sync excluded",
        "dependency_track": "original historical locked environment, not matched-control",
        "evidence_class": "preparation" if len(sys.argv) > 7 else "baseline_capture",
    },
    "load_ns": load_ns, "child_entry_to_finished_ns": time.perf_counter_ns() - entered_ns,
    "pid": os.getpid(), "module_file": str(module), "module_sha256": digest(module),
    "interpreter": sys.executable, "interpreter_sha256": digest(sys.executable),
    "python_version": sys.version, "binding_file": ort.__file__,
    "binding_sha256": digest(ort.__file__), "binding_version": ort.__version__,
    "native_binding": [
        {"path": str(p), "sha256": digest(p)}
        for p in sorted(Path(ort.__file__).parent.rglob("*.so"))
    ],
    "dependencies": dict(sorted(
        (d.metadata["Name"], d.version) for d in importlib.metadata.distributions()
    )),
    "host": {"node": platform.node(), "platform": platform.platform(),
             "machine": platform.machine(), "logical_cpus": os.cpu_count()},
    "settings": {"text": WORKLOADS[job.workload], "voice": "M1", "language": "en",
        "seed": 41024, "noise": "original np.random.randn; reset before each request",
        "steps": 8, "speed": 1.05, "silence_seconds": 0.3,
        "provider": "CPUExecutionProvider", "precision": "original model float32",
        "session_threads": [
            {"intra": s.get_session_options().intra_op_num_threads,
             "inter": s.get_session_options().inter_op_num_threads} for s in sessions],
        "instrumentation": "noise/mask copies included in synthesis; serialization excluded",
        "rss": "process lifetime high-water mark, not request-local allocation"},
}
(output / "child.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")

if len(sys.argv) > 7 and sys.argv[7] == "prepare":
    import shutil
    for original, alias in (
        ("request-00.npy", "reference_pcm.npy"),
        ("request-00-chunk-0-noise.npy", "fixed_noise.npy"),
        ("request-00-chunk-0-mask.npy", "latent_mask.npy"),
    ):
        shutil.copyfile(output / original, output / alias)
    pcm = np.load(output / "reference_pcm.npy", allow_pickle=False)
    smoke = {
        "all_zero": bool(np.all(pcm == 0)), "finite": bool(np.isfinite(pcm).all()),
        "channels": 1, "sample_rate": 44100, "sample_count": int(pcm.size),
        "binding_file": ort.__file__, "binding_version": ort.__version__,
        "interpreter": sys.executable, "interpreter_version": sys.version,
        "module_file": str(module), "module_sha256": digest(module),
        "pcm_sha256": digest(output / "reference_pcm.npy"),
        "intermediate_mask_sha256": digest(output / "latent_mask.npy"),
        "intermediate_noise_sha256": digest(output / "fixed_noise.npy"),
        "peak_rss_bytes": rows[0].peak_rss_bytes,
        "process_wall_clock_ns": result["child_entry_to_finished_ns"],
        "load_wall_clock_ns": load_ns,
        "synthesis_wall_clock_ns": rows[0].synthesis_ns,
    }
    (output / "smoke.json").write_text(json.dumps(smoke, indent=2) + "\n")
"""
