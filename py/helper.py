"""Compatibility forwarding module for the legacy helper API."""

from supertonic_runtime._legacy import (
    Style,
    TextToSpeech,
    UnicodeProcessor,
    chunk_text,
    get_latent_mask,
    length_to_mask,
    load_cfgs,
    load_onnx,
    load_onnx_all,
    load_text_processor,
    load_text_to_speech,
    load_voice_style,
    sanitize_filename,
    timer,
)

__all__ = [
    "Style",
    "TextToSpeech",
    "UnicodeProcessor",
    "chunk_text",
    "get_latent_mask",
    "length_to_mask",
    "load_cfgs",
    "load_onnx",
    "load_onnx_all",
    "load_text_processor",
    "load_text_to_speech",
    "load_voice_style",
    "sanitize_filename",
    "timer",
]
