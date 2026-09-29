"""Lightweight public SDK boundary with deferred legacy inference loading."""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from .errors import (
    PROVIDER_UNAVAILABLE,
    ProviderUnavailableError,
    RequestValidationError,
    RuntimeErrorBase,
)
from .types import (
    DEFAULT_SILENCE_SECONDS,
    DEFAULT_SPEED,
    DEFAULT_STEPS,
    RuntimeConfig,
    SynthesisRequest,
)

if TYPE_CHECKING:
    from ._legacy import Style, TextToSpeech


__all__: Final = (
    "DEFAULT_SILENCE_SECONDS",
    "DEFAULT_SPEED",
    "DEFAULT_STEPS",
    "PROVIDER_UNAVAILABLE",
    "ProviderUnavailableError",
    "RequestValidationError",
    "RuntimeConfig",
    "RuntimeErrorBase",
    "SynthesisRequest",
    "load_text_to_speech",
    "load_voice_style",
)


def load_text_to_speech(onnx_dir: str, use_gpu: bool = False) -> TextToSpeech:
    """Create the existing ONNX text-to-speech runtime on explicit request."""
    try:
        from ._legacy import load_text_to_speech as load_legacy_text_to_speech
    except ModuleNotFoundError as error:
        if error.name == "onnxruntime":
            raise ProviderUnavailableError() from error
        raise
    return load_legacy_text_to_speech(onnx_dir, use_gpu)


def load_voice_style(voice_style_paths: list[str], verbose: bool = False) -> Style:
    """Load a legacy voice style without creating an ONNX session."""
    try:
        from ._legacy import load_voice_style as load_legacy_voice_style
    except ModuleNotFoundError as error:
        if error.name == "onnxruntime":
            raise ProviderUnavailableError() from error
        raise
    return load_legacy_voice_style(voice_style_paths, verbose)
