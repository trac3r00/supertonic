"""External-consumer checks for the local runtime distribution."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
ROOT = PROJECT.parent
CACHE = ROOT / ".omo/evidence/task-2/cache/supertonic-3/724fb5abbf5502583fb520898d45929e62f02c0b"


def _run(command: list[str], *, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, check=False, text=True, capture_output=True)


def _python(environment: Path) -> Path:
    return environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def _cli(environment: Path) -> Path:
    return environment / (
        "Scripts/supertonic-runtime.exe" if os.name == "nt" else "bin/supertonic-runtime"
    )


def _wheel(tmp_path: Path) -> Path:
    wheelhouse = tmp_path / "wheelhouse"
    result = _run(
        ["uv", "build", "--project", str(PROJECT), "--wheel", "--out-dir", str(wheelhouse)],
        cwd=tmp_path,
    )
    assert result.returncode == 0, result.stderr
    wheels = tuple(wheelhouse.glob("*.whl"))
    assert len(wheels) == 1
    return wheels[0]


def _install(tmp_path: Path, wheel: Path, extra: str | None = None) -> Path:
    environment = tmp_path / ("consumer-" + (extra or "base"))
    result = _run(["uv", "venv", str(environment)], cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    target = f"{wheel}[{extra}]" if extra else str(wheel)
    result = _run(["uv", "pip", "install", "--python", str(environment), target], cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    return environment


def test_external_built_wheel_base_imports_and_provider_error_is_actionable(tmp_path: Path) -> None:
    """The base wheel imports without ORT, then requests CPU inference explicitly."""
    environment = _install(tmp_path, _wheel(tmp_path))
    script = """import sys
import supertonic_runtime as s
assert "onnxruntime" not in sys.modules
print(s.PROVIDER_UNAVAILABLE)
try:
    s.load_text_to_speech("unused")
except s.ProviderUnavailableError as error:
    print(error)
"""
    result = _run([str(_python(environment)), "-c", script], cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    assert "PROVIDER_UNAVAILABLE" in result.stdout


def test_typed_dtos_validate_without_provider(tmp_path: Path) -> None:
    """Request validation remains independent of model/provider installation."""
    environment = _install(tmp_path, _wheel(tmp_path))
    script = """from supertonic_runtime import (
    DEFAULT_SPEED,
    DEFAULT_STEPS,
    RequestValidationError,
    SynthesisRequest,
)
request = SynthesisRequest("hello", "en")
assert request.steps == DEFAULT_STEPS and request.speed == DEFAULT_SPEED
try:
    SynthesisRequest("hello", "en", steps=0)
except RequestValidationError as error:
    print(error)
"""
    result = _run([str(_python(environment)), "-c", script], cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    assert "steps" in result.stdout


def test_external_cpu_wheel_runs_legacy_compatible_synthesis(tmp_path: Path) -> None:
    """The CPU extra runs the preserved helper workflow against verified cache assets."""
    environment = _install(tmp_path, _wheel(tmp_path), "cpu")
    script = f"""from pathlib import Path
import json
import numpy as np
from supertonic_runtime import load_text_to_speech, load_voice_style
cache = Path({str(CACHE)!r})
tts = load_text_to_speech(str(cache / "onnx"))
style = load_voice_style([str(cache / "voice_styles" / "M1.json")])
wav, duration = tts("Hello from installed wheel.", "en", style, 1)
valid = int(tts.sample_rate * float(duration[0]))
assert bool(np.isfinite(wav[:, :valid]).all())
assert valid > 0
print(json.dumps({{"finite": bool(np.isfinite(wav[:, :valid]).all()), "valid_samples": valid}}))
print("FINITE_PCM_VERIFIED")
"""
    result = _run([str(_python(environment)), "-c", script], cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[-1] == "FINITE_PCM_VERIFIED"


def test_external_cli_has_help_and_rejects_empty_text(tmp_path: Path) -> None:
    """The installed command exposes help and fails malformed input actionably."""
    environment = _install(tmp_path, _wheel(tmp_path))
    result = _run([str(_cli(environment)), "--help"], cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    result = _run([str(_cli(environment)), "--text", ""], cwd=tmp_path)
    assert result.returncode != 0
    assert "text must not be empty" in result.stderr
