"""Verified, offline-only model and voice-style resolution."""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Final, TypeAlias, final

import numpy as np
from numpy.typing import NDArray

JsonScalar: TypeAlias = None | bool | int | float | str
JsonValue: TypeAlias = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]
JsonDict: TypeAlias = dict[str, JsonValue]

_MAX_ASSET_BYTES: Final = 512 * 1024 * 1024
_MAX_STYLE_VALUES: Final = 1_000_000
_REVISION: Final = re.compile(r"^[a-f0-9]{40}$")
_SHA256: Final = re.compile(r"^[a-f0-9]{64}$")
_MODEL_ID: Final = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_PRESET: Final = re.compile(r"^[FM][1-5]$")
_GRAPH_PATHS: Final = frozenset(
    {
        "onnx/duration_predictor.onnx",
        "onnx/text_encoder.onnx",
        "onnx/vector_estimator.onnx",
        "onnx/vocoder.onnx",
    }
)


@dataclass(frozen=True, slots=True)
class AssetResolutionError(Exception):
    """Structured failure raised before a model session can be constructed."""

    code: str
    message: str
    stage: str
    retryable: bool = False
    cause: str | None = None

    def __post_init__(self) -> None:
        """Expose a safe, stable exception representation."""
        Exception.__init__(self, f"{self.code}: {self.message}")


@dataclass(frozen=True, slots=True)
class AssetFile:
    """One manifest-declared, content-addressed local asset."""

    path: str
    bytes: int
    sha256: str
    kind: str
    onnx: JsonDict | None = None


@dataclass(frozen=True, slots=True)
class AssetManifest:
    """Parsed model identity and asset inventory."""

    model_id: str
    revision: str
    sample_rate: int
    files: tuple[AssetFile, ...]


@dataclass(frozen=True, slots=True)
class VoiceStyle:
    """A single verified style with immutable float32 tensors."""

    ttl: NDArray[np.float32]
    dp: NDArray[np.float32]
    source: Path
    content_sha256: str


@dataclass(frozen=True, slots=True)
class VoiceStyleBatch:
    """A stack of verified styles ready for a bounded inference batch."""

    ttl: NDArray[np.float32]
    dp: NDArray[np.float32]
    sources: tuple[Path, ...]


@dataclass(frozen=True, slots=True)
class ResolvedAssets:
    """Verified local model paths and parsed metadata without opening ONNX sessions."""

    model_id: str
    revision: str
    sample_rate: int
    root: Path
    graph_paths: Mapping[str, Path]
    config: Mapping[str, JsonValue]
    unicode_indexer: tuple[int, ...]
    preset_styles: Mapping[str, tuple[Path, str]]


def _error(
    code: str, message: str, stage: str, *, cause: str | None = None
) -> AssetResolutionError:
    return AssetResolutionError(code=code, message=message, stage=stage, cause=cause)


def _sha256_file(path: Path, expected_size: int, stage: str) -> str:
    """Hash a regular local file without following links or retaining its contents."""
    if path.is_symlink() or not path.is_file():
        raise _error("MODEL_CORRUPT", f"asset is not a regular file: {path.name}", stage)
    try:
        actual_size = path.stat().st_size
    except OSError as error:
        raise _error(
            "MODEL_NOT_FOUND", f"asset is unavailable: {path.name}", stage, cause=str(error)
        ) from error
    if actual_size != expected_size:
        raise _error("MODEL_CORRUPT", f"asset size mismatch: {path.name}", stage)
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
    except OSError as error:
        raise _error(
            "MODEL_NOT_FOUND", f"asset is unavailable: {path.name}", stage, cause=str(error)
        ) from error
    return digest.hexdigest()


def _read_json_bytes(path: Path, code: str, stage: str) -> tuple[JsonValue, bytes]:
    """Read one local JSON value with bounded size and typed error translation."""
    if path.is_symlink() or not path.is_file():
        raise _error(code, f"JSON asset is unavailable: {path.name}", stage)
    try:
        if path.stat().st_size > _MAX_ASSET_BYTES:
            raise _error(code, f"JSON asset has invalid size: {path.name}", stage)
        data = path.read_bytes()
    except OSError as error:
        raise _error(
            code, f"JSON asset is unavailable: {path.name}", stage, cause=str(error)
        ) from error
    if not data or len(data) > _MAX_ASSET_BYTES:
        raise _error(code, f"JSON asset has invalid size: {path.name}", stage)
    try:
        return json.loads(data), data
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise _error(
            code, f"JSON asset is malformed: {path.name}", stage, cause=str(error)
        ) from error


def _dict(value: JsonValue, label: str, code: str, stage: str) -> JsonDict:
    if not isinstance(value, dict):
        raise _error(code, f"{label} must be an object", stage)
    return value


def _list(value: JsonValue, label: str, code: str, stage: str) -> list[JsonValue]:
    if not isinstance(value, list):
        raise _error(code, f"{label} must be an array", stage)
    return value


def _string(value: JsonValue | None, label: str, code: str, stage: str) -> str:
    if not isinstance(value, str) or not value:
        raise _error(code, f"{label} must be a non-empty string", stage)
    return value


def _int(value: JsonValue | None, label: str, code: str, stage: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise _error(code, f"{label} must be a positive integer", stage)
    return value


def _safe_path(value: str) -> str:
    path = PurePosixPath(value)
    if path.is_absolute() or "\\" in value or any(part in {"", ".", ".."} for part in path.parts):
        raise _error("MODEL_CORRUPT", f"unsafe manifest asset path: {value}", "manifest")
    return value


def _parse_file(value: JsonValue, seen: set[str]) -> AssetFile:
    raw = _dict(value, "manifest file", "MODEL_CORRUPT", "manifest")
    path = _safe_path(_string(raw.get("path"), "file.path", "MODEL_CORRUPT", "manifest"))
    if path in seen:
        raise _error("MODEL_CORRUPT", f"duplicate manifest asset path: {path}", "manifest")
    seen.add(path)
    size = _int(raw.get("bytes"), "file.bytes", "MODEL_CORRUPT", "manifest")
    if size > _MAX_ASSET_BYTES:
        raise _error("MODEL_CORRUPT", f"asset exceeds size cap: {path}", "manifest")
    digest = _string(raw.get("sha256"), "file.sha256", "MODEL_CORRUPT", "manifest")
    if _SHA256.fullmatch(digest) is None:
        raise _error("MODEL_CORRUPT", f"invalid SHA-256: {path}", "manifest")
    kind = _string(raw.get("kind"), "file.kind", "MODEL_CORRUPT", "manifest")
    onnx_value = raw.get("onnx")
    onnx = (
        None if onnx_value is None else _dict(onnx_value, "file.onnx", "MODEL_CORRUPT", "manifest")
    )
    return AssetFile(path=path, bytes=size, sha256=digest, kind=kind, onnx=onnx)


def _parse_manifest(path: Path) -> AssetManifest:
    raw_value, _ = _read_json_bytes(path, "MODEL_CORRUPT", "manifest")
    raw = _dict(raw_value, "manifest", "MODEL_CORRUPT", "manifest")
    if raw.get("schemaVersion") != 1:
        raise _error("MODEL_INCOMPATIBLE", "unsupported manifest schema version", "manifest")
    model = _dict(raw.get("model"), "manifest.model", "MODEL_CORRUPT", "manifest")
    model_id = _string(model.get("id"), "model.id", "MODEL_CORRUPT", "manifest")
    revision = _string(model.get("revision"), "model.revision", "MODEL_CORRUPT", "manifest")
    if _MODEL_ID.fullmatch(model_id) is None or _REVISION.fullmatch(revision) is None:
        raise _error("MODEL_CORRUPT", "manifest model identity is invalid", "manifest")
    sample_rate = _int(model.get("sampleRate"), "model.sampleRate", "MODEL_CORRUPT", "manifest")
    _ = _dict(raw.get("source"), "manifest.source", "MODEL_CORRUPT", "manifest")
    seen: set[str] = set()
    files = tuple(
        _parse_file(item, seen)
        for item in _list(raw.get("files"), "manifest.files", "MODEL_CORRUPT", "manifest")
    )
    if not files:
        raise _error("MODEL_CORRUPT", "manifest has no assets", "manifest")
    return AssetManifest(model_id=model_id, revision=revision, sample_rate=sample_rate, files=files)


def _style_shape(asset: AssetFile, input_name: str, tail: tuple[int, int]) -> None:
    graph_path = asset.path
    onnx = asset.onnx
    graph = _dict(onnx, f"{graph_path}.onnx", "MODEL_CORRUPT", "manifest")
    inputs = _list(graph.get("inputs"), f"{graph_path}.inputs", "MODEL_CORRUPT", "manifest")
    for value in inputs:
        input_value = _dict(value, "graph input", "MODEL_CORRUPT", "manifest")
        if input_value.get("name") == input_name:
            shape = _list(
                input_value.get("shape"), f"{input_name}.shape", "MODEL_CORRUPT", "manifest"
            )
            if input_value.get("elementType") != "FLOAT" or shape != ["batch_size", *tail]:
                raise _error(
                    "MODEL_INCOMPATIBLE", f"{graph_path} style metadata is incompatible", "manifest"
                )
            return
    raise _error("MODEL_INCOMPATIBLE", f"{graph_path} omits {input_name}", "manifest")


def _validate_config(
    config: JsonDict, indexer: JsonValue, manifest: AssetManifest
) -> tuple[Mapping[str, JsonValue], tuple[int, ...]]:
    ae = _dict(config.get("ae"), "config.ae", "MODEL_INCOMPATIBLE", "config")
    if (
        _int(ae.get("sample_rate"), "config.ae.sample_rate", "MODEL_INCOMPATIBLE", "config")
        != manifest.sample_rate
    ):
        raise _error("MODEL_INCOMPATIBLE", "config sample rate differs from manifest", "config")
    ttl = _dict(config.get("ttl"), "config.ttl", "MODEL_INCOMPATIBLE", "config")
    ttl_masker = _dict(
        ttl.get("uncond_masker"), "config.ttl.uncond_masker", "MODEL_INCOMPATIBLE", "config"
    )
    dp = _dict(config.get("dp"), "config.dp", "MODEL_INCOMPATIBLE", "config")
    dp_encoder = _dict(
        dp.get("style_encoder"), "config.dp.style_encoder", "MODEL_INCOMPATIBLE", "config"
    )
    dp_tokens = _dict(
        dp_encoder.get("style_token_layer"),
        "config.dp.style_token_layer",
        "MODEL_INCOMPATIBLE",
        "config",
    )
    if (
        _int(ttl_masker.get("n_style"), "ttl n_style", "MODEL_INCOMPATIBLE", "config"),
        _int(
            ttl_masker.get("style_value_dim"), "ttl style_value_dim", "MODEL_INCOMPATIBLE", "config"
        ),
    ) != (50, 256):
        raise _error("MODEL_INCOMPATIBLE", "config ttl style shape is incompatible", "config")
    if (
        _int(dp_tokens.get("n_style"), "dp n_style", "MODEL_INCOMPATIBLE", "config"),
        _int(
            dp_tokens.get("style_value_dim"), "dp style_value_dim", "MODEL_INCOMPATIBLE", "config"
        ),
    ) != (8, 16):
        raise _error("MODEL_INCOMPATIBLE", "config dp style shape is incompatible", "config")
    raw_indexer = _list(indexer, "unicode indexer", "MODEL_INCOMPATIBLE", "indexer")
    if len(raw_indexer) != 65536:
        raise _error("MODEL_INCOMPATIBLE", "unicode indexer has invalid cardinality", "indexer")
    parsed: list[int] = []
    for item in raw_indexer:
        if isinstance(item, bool) or not isinstance(item, int) or item < -1:
            raise _error("MODEL_CORRUPT", "unicode indexer contains an invalid value", "indexer")
        parsed.append(item)
    return MappingProxyType(config.copy()), tuple(parsed)


@final
class AssetResolver:
    """Resolve only local verified assets; this class has no network capability."""

    def __init__(
        self, manifest_path: Path, cache_root: Path | None = None, max_style_entries: int = 32
    ) -> None:
        if max_style_entries < 1:
            raise _error("INVALID_ARGUMENT", "max_style_entries must be positive", "resolver")
        self._manifest_path = manifest_path
        self._cache_root = cache_root
        self._max_style_entries = max_style_entries
        self._style_cache: OrderedDict[tuple[str, str, str], VoiceStyle] = OrderedDict()

    @property
    def cached_style_count(self) -> int:
        """Return the current bounded cache size for diagnostics."""
        return len(self._style_cache)

    def resolve(
        self,
        *,
        model_id: str | None = None,
        revision: str | None = None,
        asset_root: Path | None = None,
    ) -> ResolvedAssets:
        """Validate a local bundle, returning paths only after all checks pass."""
        manifest = _parse_manifest(self._manifest_path)
        if model_id is not None and model_id != manifest.model_id:
            raise _error(
                "MODEL_INCOMPATIBLE", "requested model id differs from manifest", "identity"
            )
        if revision is not None and revision != manifest.revision:
            raise _error(
                "MODEL_INCOMPATIBLE", "requested revision differs from manifest", "identity"
            )
        root = (asset_root if asset_root is not None else self._cache_path(manifest)).resolve(
            strict=False
        )
        if root.is_symlink() or not root.is_dir():
            raise _error("MODEL_NOT_FOUND", "verified local model bundle is unavailable", "cache")
        if asset_root is None:
            cached_manifest = _parse_manifest(root / "manifest.json")
            if cached_manifest != manifest:
                raise _error(
                    "MODEL_INCOMPATIBLE",
                    "cached manifest identity differs from requested manifest",
                    "cache",
                )
        file_by_path = {entry.path: entry for entry in manifest.files}
        required_kinds = {path: "graph" for path in _GRAPH_PATHS}
        required_kinds.update({"onnx/tts.json": "metadata", "onnx/unicode_indexer.json": "indexer"})
        if any(
            path not in file_by_path or file_by_path[path].kind != kind
            for path, kind in required_kinds.items()
        ):
            raise _error(
                "MODEL_INCOMPATIBLE", "manifest omits or mislabels a required asset", "manifest"
            )
        graph_paths: dict[str, Path] = {}
        verified_paths: dict[str, Path] = {}
        for entry in manifest.files:
            candidate = root
            for component in PurePosixPath(entry.path).parts:
                candidate = candidate / component
                if candidate.is_symlink():
                    raise _error(
                        "MODEL_CORRUPT", f"asset path contains a link: {entry.path}", "asset"
                    )
            resolved = candidate.resolve(strict=False)
            if not resolved.is_relative_to(root):
                raise _error("MODEL_CORRUPT", f"asset escapes model bundle: {entry.path}", "asset")
            if _sha256_file(resolved, entry.bytes, "asset") != entry.sha256:
                raise _error("MODEL_CORRUPT", f"asset digest mismatch: {entry.path}", "asset")
            verified_paths[entry.path] = resolved
            if entry.kind == "graph":
                graph_paths[entry.path] = resolved
        _style_shape(file_by_path["onnx/duration_predictor.onnx"], "style_dp", (8, 16))
        _style_shape(file_by_path["onnx/text_encoder.onnx"], "style_ttl", (50, 256))
        config_value, _ = _read_json_bytes(
            verified_paths["onnx/tts.json"], "MODEL_CORRUPT", "config"
        )
        indexer_value, _ = _read_json_bytes(
            verified_paths["onnx/unicode_indexer.json"], "MODEL_CORRUPT", "indexer"
        )
        config, indexer = _validate_config(
            _dict(config_value, "config", "MODEL_CORRUPT", "config"), indexer_value, manifest
        )
        styles = {
            Path(entry.path).stem: (verified_paths[entry.path], entry.sha256)
            for entry in manifest.files
            if entry.kind == "style"
        }
        if not styles:
            raise _error("MODEL_INCOMPATIBLE", "manifest omits voice styles", "manifest")
        return ResolvedAssets(
            model_id=manifest.model_id,
            revision=manifest.revision,
            sample_rate=manifest.sample_rate,
            root=root,
            graph_paths=MappingProxyType(graph_paths),
            config=config,
            unicode_indexer=indexer,
            preset_styles=MappingProxyType(styles),
        )

    def load_styles(
        self, assets: ResolvedAssets, references: Sequence[str | Path]
    ) -> VoiceStyleBatch:
        """Load verified preset or explicitly identity-bound custom styles from disk."""
        if not references:
            raise _error("INVALID_ARGUMENT", "at least one style is required", "style")
        styles = tuple(self._load_style(assets, reference) for reference in references)
        ttl = np.concatenate(tuple(style.ttl for style in styles), axis=0).astype(
            np.float32, copy=False
        )
        dp = np.concatenate(tuple(style.dp for style in styles), axis=0).astype(
            np.float32, copy=False
        )
        ttl.setflags(write=False)
        dp.setflags(write=False)
        return VoiceStyleBatch(ttl=ttl, dp=dp, sources=tuple(style.source for style in styles))

    def _cache_path(self, manifest: AssetManifest) -> Path:
        if self._cache_root is None:
            raise _error("MODEL_NOT_FOUND", "cache_root or asset_root is required", "cache")
        return self._cache_root / manifest.model_id / manifest.revision

    def _load_style(self, assets: ResolvedAssets, reference: str | Path) -> VoiceStyle:
        if isinstance(reference, Path):
            return self._load_style_path(assets, reference, explicit=True)
        if _PRESET.fullmatch(reference) is None:
            return self._load_style_path(assets, Path(reference), explicit=True)
        preset = assets.preset_styles.get(reference)
        if preset is None:
            raise _error("STYLE_MISMATCH", f"preset style is not in manifest: {reference}", "style")
        return self._load_style_path(assets, preset[0], explicit=False)

    def _load_style_path(self, assets: ResolvedAssets, path: Path, *, explicit: bool) -> VoiceStyle:
        resolved = path.resolve(strict=False)
        preset = next((item for item in assets.preset_styles.values() if item[0] == resolved), None)
        raw, data = _read_json_bytes(resolved, "STYLE_MISMATCH", "style")
        digest = hashlib.sha256(data).hexdigest()
        if preset is not None and digest != preset[1]:
            raise _error("MODEL_CORRUPT", f"preset style digest mismatch: {resolved.name}", "style")
        key = (assets.model_id, assets.revision, digest)
        cached = self._style_cache.get(key)
        if cached is not None:
            self._style_cache.move_to_end(key)
            return cached
        style = self._parse_style(
            raw, resolved, assets, require_identity=explicit and preset is None, digest=digest
        )
        self._style_cache[key] = style
        self._style_cache.move_to_end(key)
        while len(self._style_cache) > self._max_style_entries:
            _ = self._style_cache.popitem(last=False)
        return style

    def _parse_style(
        self,
        raw: JsonValue,
        path: Path,
        assets: ResolvedAssets,
        *,
        require_identity: bool,
        digest: str,
    ) -> VoiceStyle:
        style = _dict(raw, "style", "STYLE_MISMATCH", "style")
        ttl = _style_array(style.get("style_ttl"), (1, 50, 256), "style_ttl")
        dp = _style_array(style.get("style_dp"), (1, 8, 16), "style_dp")
        metadata = _dict(style.get("metadata"), "style.metadata", "STYLE_MISMATCH", "style")
        if (
            _int(
                metadata.get("target_sample_rate"),
                "style target sample rate",
                "STYLE_MISMATCH",
                "style",
            )
            != assets.sample_rate
        ):
            raise _error("STYLE_MISMATCH", "style sample rate differs from model", "style")
        if require_identity:
            model_id = _string(
                metadata.get("model_id"), "style model_id", "STYLE_MISMATCH", "style"
            )
            revision = _string(
                metadata.get("model_revision"), "style model_revision", "STYLE_MISMATCH", "style"
            )
            if model_id != assets.model_id or revision != assets.revision:
                raise _error(
                    "STYLE_MISMATCH", "style model identity differs from resolved model", "style"
                )
        ttl.setflags(write=False)
        dp.setflags(write=False)
        return VoiceStyle(ttl=ttl, dp=dp, source=path, content_sha256=digest)


def _style_array(
    value: JsonValue | None, expected_dims: tuple[int, int, int], label: str
) -> NDArray[np.float32]:
    raw = _dict(value, label, "STYLE_MISMATCH", "style")
    if raw.get("type") != "float32":
        raise _error("STYLE_MISMATCH", f"{label} type must be float32", "style")
    dims = _list(raw.get("dims"), f"{label}.dims", "STYLE_MISMATCH", "style")
    if dims != list(expected_dims):
        raise _error("STYLE_MISMATCH", f"{label} dimensions are incompatible", "style")
    expected_count = math.prod(expected_dims)
    if expected_count > _MAX_STYLE_VALUES:
        raise _error("STYLE_MISMATCH", f"{label} exceeds style value cap", "style")
    values: list[float] = []
    _flatten_numbers(raw.get("data"), values, label, expected_count)
    if len(values) != expected_count:
        raise _error("STYLE_MISMATCH", f"{label} data length differs from dimensions", "style")
    array = np.asarray(values, dtype=np.float32).reshape(expected_dims)
    if not bool(np.isfinite(array).all()):
        raise _error("STYLE_MISMATCH", f"{label} contains non-finite float32 values", "style")
    return array


def _flatten_numbers(
    value: JsonValue | None, target: list[float], label: str, expected_count: int
) -> None:
    if isinstance(value, list):
        for item in value:
            _flatten_numbers(item, target, label, expected_count)
        return
    if len(target) >= expected_count:
        raise _error("STYLE_MISMATCH", f"{label} data length differs from dimensions", "style")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _error("STYLE_MISMATCH", f"{label} contains a non-numeric value", "style")
    target.append(float(value))
