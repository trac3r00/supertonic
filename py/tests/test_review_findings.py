"""Regression tests for verified assets and request/text boundary checks."""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from importlib import import_module
from pathlib import Path
from typing import cast

import pytest

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

runtime = import_module("supertonic_runtime")
asset_module = import_module("supertonic_runtime.assets")
UnicodeProcessor = import_module("supertonic_runtime._legacy").UnicodeProcessor
fixtures = import_module("test_assets")
RequestValidationError = runtime.RequestValidationError
RuntimeConfig = runtime.RuntimeConfig
SynthesisRequest = runtime.SynthesisRequest
AssetResolutionError = asset_module.AssetResolutionError
AssetResolver = asset_module.AssetResolver
_fixture_assets = fixtures._fixture_assets
_write_json = fixtures._write_json


def _change_manifest(
    manifest_path: Path, root: Path, relative_path: str, kind: str | None
) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for entry in manifest["files"]:
        if entry["path"] == relative_path:
            if kind is None:
                manifest["files"].remove(entry)
            else:
                entry["kind"] = kind
            break
    else:
        raise AssertionError(f"missing fixture entry: {relative_path}")
    data = _write_json(manifest_path, manifest)
    (root / "manifest.json").write_bytes(data)


@pytest.mark.parametrize("path", ["onnx/tts.json", "onnx/unicode_indexer.json"])
@pytest.mark.parametrize("kind", [None, "style"])
def test_required_json_must_be_declared_with_its_kind(
    tmp_path: Path, path: str, kind: str | None
) -> None:
    cache, manifest, root = _fixture_assets(tmp_path)
    _change_manifest(manifest, root, path, kind)
    with pytest.raises(AssetResolutionError) as error:
        AssetResolver(manifest, cache).resolve()
    assert error.value.code == "MODEL_INCOMPATIBLE"


@pytest.mark.parametrize(
    "graph", [
        "onnx/duration_predictor.onnx", "onnx/text_encoder.onnx",
        "onnx/vector_estimator.onnx", "onnx/vocoder.onnx",
    ]
)
def test_required_graph_must_have_graph_kind(tmp_path: Path, graph: str) -> None:
    cache, manifest, root = _fixture_assets(tmp_path)
    _change_manifest(manifest, root, graph, "metadata")
    with pytest.raises(AssetResolutionError) as error:
        AssetResolver(manifest, cache).resolve()
    assert error.value.code == "MODEL_INCOMPATIBLE"


def test_asset_directory_symlink_is_rejected_before_hashing(tmp_path: Path) -> None:
    cache, manifest, root = _fixture_assets(tmp_path)
    outside = tmp_path / "outside"
    (root / "onnx").rename(outside)
    (root / "onnx").symlink_to(outside, target_is_directory=True)
    with pytest.raises(AssetResolutionError) as error:
        AssetResolver(manifest, cache).resolve()
    assert error.value.code == "MODEL_CORRUPT"


def test_symlink_to_explicit_bundle_root_is_rejected(tmp_path: Path) -> None:
    _, manifest, root = _fixture_assets(tmp_path)
    linked = tmp_path / "linked"
    linked.symlink_to(root, target_is_directory=True)
    with pytest.raises(AssetResolutionError) as error:
        AssetResolver(manifest).resolve(asset_root=linked)
    assert error.value.code == "MODEL_NOT_FOUND"


@pytest.mark.parametrize("depth", [0, 1, 2])
def test_symlinked_cache_components_are_rejected(tmp_path: Path, depth: int) -> None:
    cache, manifest, root = _fixture_assets(tmp_path)
    linked = [cache, root.parent, root][depth]
    outside = tmp_path / "outside"
    linked.rename(outside)
    linked.symlink_to(outside, target_is_directory=True)
    with pytest.raises(AssetResolutionError) as error:
        AssetResolver(manifest, cache).resolve()
    assert error.value.code == "MODEL_NOT_FOUND"


def test_json_size_checked_before_read(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "too-large.json"
    path.write_bytes(b"0" * 33)
    monkeypatch.setattr(asset_module, "_MAX_ASSET_BYTES", 32)
    original = Path.read_bytes

    def read_bytes(candidate: Path) -> bytes:
        if candidate == path:
            raise AssertionError("oversize JSON must not be read")
        return original(candidate)

    monkeypatch.setattr(Path, "read_bytes", read_bytes)
    with pytest.raises(AssetResolutionError) as error:
        asset_module._read_json_bytes(path, "MODEL_CORRUPT", "manifest")
    assert error.value.code == "MODEL_CORRUPT"


def test_style_flattening_stops_at_declared_count() -> None:
    class Excess(float):
        def __float__(self) -> float:
            raise AssertionError("excess values must not be materialized")

    payload = {
        "type": "float32", "dims": [1, 50, 256],
        "data": [0.0] * (50 * 256) + [Excess(1.0)],
    }
    with pytest.raises(AssetResolutionError) as error:
        asset_module._style_array(payload, (1, 50, 256), "style_ttl")
    assert error.value.code == "STYLE_MISMATCH"


@pytest.mark.parametrize("make_invalid", [
    lambda: RuntimeConfig(cast(Path, "")),
    lambda: SynthesisRequest("", "en"),
    lambda: SynthesisRequest("hello", "en", steps=0),
    lambda: SynthesisRequest("hello", "en", speed=0),
    lambda: SynthesisRequest("hello", "en", silence_seconds=-1),
])
def test_request_errors_retain_code(make_invalid: Callable[[], object]) -> None:
    with pytest.raises(RequestValidationError) as error:
        make_invalid()
    assert error.value.code == "INVALID_REQUEST"


@pytest.mark.parametrize("language", ["zz", "EN", ""])
def test_unsupported_language_rejected(language: str) -> None:
    with pytest.raises(RequestValidationError) as error:
        SynthesisRequest("hello", language)
    assert error.value.code == "INVALID_REQUEST"


def _processor() -> UnicodeProcessor:
    # Avoid loading model assets: only the scalar-to-token indexer is needed.
    processor = UnicodeProcessor.__new__(UnicodeProcessor)
    processor.indexer = [0] * 65536
    return processor


def test_astral_scalar_does_not_wrap_to_bmp() -> None:
    processor = _processor()
    with pytest.raises(ValueError, match="Unsupported Unicode"):
        processor(["\U00020000"], ["en"])


def test_unsupported_indexer_sentinel_rejected() -> None:
    processor = _processor()
    processor.indexer[ord("A")] = -1
    with pytest.raises(ValueError, match="Unsupported Unicode"):
        processor(["A"], ["en"])


def test_mismatched_language_batch_rejected() -> None:
    processor = _processor()
    with pytest.raises(ValueError, match="same length"):
        processor(["first", "second"], ["en"])
