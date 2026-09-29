"""Boundary tests for the offline verified asset resolver."""

from __future__ import annotations

import hashlib
import json
import sys
from importlib import import_module
from pathlib import Path

import numpy as np
import pytest

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

assets_module = import_module("supertonic_runtime.assets")
AssetResolutionError = assets_module.AssetResolutionError
AssetResolver = assets_module.AssetResolver

REVISION = "724fb5abbf5502583fb520898d45929e62f02c0b"
MODEL_ID = "supertonic-3"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_json(path: Path, value: object) -> bytes:
    data = json.dumps(value, allow_nan=True, separators=(",", ":")).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def _style_data(rows: int, columns: int, value: float = 0.25) -> list[list[list[float]]]:
    return [[[value for _ in range(columns)] for _ in range(rows)]]


def _style_payload(
    *,
    ttl_dims: list[int] | None = None,
    ttl_data: list[list[list[float]]] | None = None,
    model_id: str | None = None,
    revision: str | None = None,
) -> dict[str, object]:
    metadata: dict[str, object] = {
        "source_sample_rate": 44100,
        "target_sample_rate": 44100,
    }
    if model_id is not None:
        metadata["model_id"] = model_id
    if revision is not None:
        metadata["model_revision"] = revision
    return {
        "style_ttl": {
            "type": "float32",
            "dims": ttl_dims or [1, 50, 256],
            "data": ttl_data or _style_data(50, 256),
        },
        "style_dp": {
            "type": "float32",
            "dims": [1, 8, 16],
            "data": _style_data(8, 16),
        },
        "metadata": metadata,
    }


def _graph_metadata(path: str) -> dict[str, object]:
    match path:
        case "onnx/duration_predictor.onnx":
            return {
                "inputs": [
                    {"name": "style_dp", "elementType": "FLOAT", "shape": ["batch_size", 8, 16]}
                ]
            }
        case "onnx/text_encoder.onnx":
            return {
                "inputs": [
                    {
                        "name": "style_ttl",
                        "elementType": "FLOAT",
                        "shape": ["batch_size", 50, 256],
                    }
                ]
            }
        case "onnx/vector_estimator.onnx" | "onnx/vocoder.onnx":
            return {"inputs": []}
        case _:  # pragma: no cover - keeps fixture literals complete
            raise AssertionError(f"unexpected graph {path}")


def _fixture_assets(tmp_path: Path) -> tuple[Path, Path, Path]:
    """Create a complete tiny cache whose declared schema matches Supertonic-3."""
    cache_root = tmp_path / "cache"
    root = cache_root / MODEL_ID / REVISION
    files: list[dict[str, object]] = []
    for relative_path in (
        "onnx/duration_predictor.onnx",
        "onnx/text_encoder.onnx",
        "onnx/vector_estimator.onnx",
        "onnx/vocoder.onnx",
    ):
        data = relative_path.encode("utf-8")
        target = root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files.append(
            {
                "path": relative_path,
                "bytes": len(data),
                "sha256": _sha256(data),
                "kind": "graph",
                "onnx": _graph_metadata(relative_path),
            }
        )
    config = {
        "ae": {"sample_rate": 44100},
        "ttl": {"uncond_masker": {"n_style": 50, "style_value_dim": 256}},
        "dp": {"style_encoder": {"style_token_layer": {"n_style": 8, "style_value_dim": 16}}},
    }
    for relative_path, value, kind in (
        ("onnx/tts.json", config, "metadata"),
        ("onnx/unicode_indexer.json", [-1] * 65536, "indexer"),
        ("voice_styles/F1.json", _style_payload(), "style"),
    ):
        data = _write_json(root / relative_path, value)
        files.append(
            {"path": relative_path, "bytes": len(data), "sha256": _sha256(data), "kind": kind}
        )
    manifest = {
        "schemaVersion": 1,
        "model": {"id": MODEL_ID, "revision": REVISION, "sampleRate": 44100},
        "source": {"baseUrl": f"https://example.invalid/{REVISION}"},
        "files": files,
    }
    manifest_path = tmp_path / "manifest.json"
    manifest_bytes = _write_json(manifest_path, manifest)
    (root / "manifest.json").write_bytes(manifest_bytes)
    return cache_root, manifest_path, root


def _resolver(tmp_path: Path) -> tuple[AssetResolver, Path]:
    cache_root, manifest_path, root = _fixture_assets(tmp_path)
    return AssetResolver(
        manifest_path=manifest_path, cache_root=cache_root, max_style_entries=1
    ), root


def _codes(error: pytest.ExceptionInfo[BaseException]) -> str:
    return getattr(error.value, "code")


def test_cached_assets_and_preset_custom_styles_round_trip_without_network(tmp_path: Path) -> None:
    resolver, root = _resolver(tmp_path)
    assets = resolver.resolve()

    custom = root.parent / "custom.json"
    _write_json(
        custom,
        _style_payload(model_id=MODEL_ID, revision=REVISION, ttl_data=_style_data(50, 256, 0.75)),
    )
    styles = resolver.load_styles(assets, ("F1", custom))

    assert assets.root == root
    assert styles.ttl.shape == (2, 50, 256)
    assert styles.dp.shape == (2, 8, 16)
    assert styles.ttl.dtype == np.dtype(np.float32)
    assert styles.dp.dtype == np.dtype(np.float32)
    assert np.isfinite(styles.ttl).all()
    assert np.isfinite(styles.dp).all()
    assert styles.ttl[1, 0, 0] == np.float32(0.75)


def test_malformed_style_shapes_lengths_and_nonfinite_values_fail_before_use(
    tmp_path: Path,
) -> None:
    resolver, root = _resolver(tmp_path)
    assets = resolver.resolve()
    invalid_payloads = (
        _style_payload(ttl_dims=[1, 50]),
        _style_payload(ttl_data=[[[0.25]]]),
        _style_payload(ttl_data=_style_data(50, 256, float("nan"))),
    )

    for index, payload in enumerate(invalid_payloads):
        path = root.parent / f"invalid-{index}.json"
        _write_json(path, payload)
        with pytest.raises(AssetResolutionError) as error:
            _ = resolver.load_styles(assets, (path,))
        assert _codes(error) == "STYLE_MISMATCH"


def test_traversal_wrong_revision_and_corrupt_assets_are_typed(tmp_path: Path) -> None:
    cache_root, manifest_path, root = _fixture_assets(tmp_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"][0]["path"] = "../outside.onnx"
    _write_json(manifest_path, manifest)
    with pytest.raises(AssetResolutionError) as traversal:
        _ = AssetResolver(manifest_path=manifest_path, cache_root=cache_root).resolve()
    assert _codes(traversal) == "MODEL_CORRUPT"

    _, manifest_path, root = _fixture_assets(tmp_path / "revision")
    resolver = AssetResolver(manifest_path=manifest_path, cache_root=cache_root)
    with pytest.raises(AssetResolutionError) as wrong_revision:
        _ = resolver.resolve(revision="0" * 40)
    assert _codes(wrong_revision) == "MODEL_INCOMPATIBLE"

    resolver, root = _resolver(tmp_path / "corrupt")
    (root / "onnx" / "vocoder.onnx").write_bytes(b"corrupt")
    with pytest.raises(AssetResolutionError) as corrupt:
        _ = resolver.resolve()
    assert _codes(corrupt) == "MODEL_CORRUPT"


def test_style_cache_uses_content_and_model_identity_and_is_bounded(tmp_path: Path) -> None:
    resolver, root = _resolver(tmp_path)
    assets = resolver.resolve()
    custom = root.parent / "custom.json"
    _write_json(
        custom,
        _style_payload(model_id=MODEL_ID, revision=REVISION, ttl_data=_style_data(50, 256, 0.1)),
    )
    first = resolver.load_styles(assets, (custom,))
    _write_json(
        custom,
        _style_payload(model_id=MODEL_ID, revision=REVISION, ttl_data=_style_data(50, 256, 0.9)),
    )
    second = resolver.load_styles(assets, (custom,))

    assert first.ttl[0, 0, 0] == np.float32(0.1)
    assert second.ttl[0, 0, 0] == np.float32(0.9)
    assert resolver.cached_style_count == 1

    incompatible = root.parent / "v2.json"
    _write_json(incompatible, _style_payload(model_id="supertonic-2", revision="1" * 40))
    with pytest.raises(AssetResolutionError) as error:
        _ = resolver.load_styles(assets, (incompatible,))
    assert _codes(error) == "STYLE_MISMATCH"


def test_cached_manifest_identity_mismatch_fails_before_model_use(tmp_path: Path) -> None:
    resolver, root = _resolver(tmp_path)
    cached_manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    cached_manifest["model"]["revision"] = "0" * 40
    _write_json(root / "manifest.json", cached_manifest)

    with pytest.raises(AssetResolutionError) as error:
        _ = resolver.resolve()

    assert _codes(error) == "MODEL_INCOMPATIBLE"
