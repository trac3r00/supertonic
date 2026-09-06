"""Validated public request and configuration data transfer objects."""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from pathlib import Path
from typing import Final

from .errors import RequestValidationError

DEFAULT_STEPS: Final = 8
DEFAULT_SPEED: Final = 1.05
DEFAULT_SILENCE_SECONDS: Final = 0.3


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    """Location and provider selection for a legacy-compatible runtime."""

    onnx_dir: Path
    use_gpu: bool = False

    def __post_init__(self) -> None:
        """Reject an empty model location before optional inference is loaded."""
        if not str(self.onnx_dir):
            raise RequestValidationError("onnx_dir must not be empty")


@dataclass(frozen=True, slots=True)
class SynthesisRequest:
    """Validated synthesis inputs retaining legacy defaults."""

    text: str
    language: str
    steps: int = DEFAULT_STEPS
    speed: float = DEFAULT_SPEED
    silence_seconds: float = DEFAULT_SILENCE_SECONDS

    def __post_init__(self) -> None:
        """Validate inexpensive request constraints without loading a provider."""
        if not self.text:
            raise RequestValidationError("text must not be empty")
        if not self.language:
            raise RequestValidationError("language must not be empty")
        if not 1 <= self.steps <= 100:
            raise RequestValidationError("steps must be between 1 and 100")
        if not isfinite(self.speed) or not 0.7 <= self.speed <= 2.0:
            raise RequestValidationError("speed must be finite and between 0.7 and 2.0")
        if not isfinite(self.silence_seconds) or not 0.0 <= self.silence_seconds <= 5.0:
            raise RequestValidationError("silence_seconds must be finite and between 0.0 and 5.0")
