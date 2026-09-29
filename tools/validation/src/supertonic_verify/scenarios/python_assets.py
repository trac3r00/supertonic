"""Real offline asset validation for the Python runtime."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

from supertonic_verify.runner import execute_child

if TYPE_CHECKING:
    from supertonic_verify.models import ChildExecution, EvidenceClass, Outcome

SCENARIO: Final = "assets-offline-and-corrupt"
_SUCCESS_MARKER: Final = "ASSETS_Q_VERIFIED"
_MISSING_MARKER: Final = "ASSETS_Q_MISSING"
_MISSING_PREREQUISITE_EXIT: Final = 77
_TIMEOUT_SECONDS: Final = 45.0
_SCRIPT: Final = r"""
from __future__ import annotations

import json
import shutil
import socket
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
run_dir = Path(sys.argv[2]).resolve()
scratch_dir = Path(sys.argv[3]).resolve()
sys.path.insert(0, str(root / "py"))

from supertonic_runtime.assets import AssetResolutionError, AssetResolver

cache_root = root / ".omo/evidence/task-2/cache"
manifest_path = root / "contracts/v1/models/supertonic-3.json"
work_dir = scratch_dir / "assets-q"
resource_path = run_dir / "assets-q-resources.json"
artifact_path = run_dir / "assets-offline-and-corrupt.json"
work_dir.mkdir(parents=True, exist_ok=False)
resource_path.write_text(
    json.dumps({"scratch": str(work_dir), "network_guard": "socket.connect"}) + "\n",
    encoding="utf-8",
)
original_connect = socket.socket.connect
attempts = 0

def deny_network(self, address):
    global attempts
    attempts += 1
    raise RuntimeError(f"network denied: {address}")

socket.socket.connect = deny_network
result = {"scenario": "assets-offline-and-corrupt"}
exit_code = 0
try:
    resolver = AssetResolver(
        manifest_path=manifest_path,
        cache_root=cache_root,
        max_style_entries=1,
    )
    try:
        assets = resolver.resolve()
    except AssetResolutionError as error:
        if error.code != "MODEL_NOT_FOUND":
            raise
        result["initial_error"] = error.code
        exit_code = 77
    else:
        official = resolver.load_styles(assets, ("F1", "M1"))
        custom_path = work_dir / "custom.json"
        payload = json.loads((assets.root / "voice_styles/F1.json").read_text(encoding="utf-8"))
        payload["metadata"]["model_id"] = assets.model_id
        payload["metadata"]["model_revision"] = assets.revision
        custom_path.write_text(json.dumps(payload), encoding="utf-8")
        first = resolver.load_styles(assets, (custom_path,))
        payload["style_ttl"]["data"][0][0][0] = 0.9875
        custom_path.write_text(json.dumps(payload), encoding="utf-8")
        second = resolver.load_styles(assets, (custom_path,))

        corrupt_manifest_path = work_dir / "corrupt-manifest.json"
        corrupt_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        corrupt_manifest["files"][0]["sha256"] = "0" * 64
        corrupt_manifest_path.write_text(json.dumps(corrupt_manifest), encoding="utf-8")

        invalid_style_path = work_dir / "v2.json"
        invalid_style = json.loads(custom_path.read_text(encoding="utf-8"))
        invalid_style["metadata"]["model_id"] = "supertonic-2"
        invalid_style["metadata"]["model_revision"] = "1" * 40
        invalid_style_path.write_text(json.dumps(invalid_style), encoding="utf-8")

        checks = {
            "missing": lambda: resolver.resolve(asset_root=work_dir / "missing"),
            "wrong_revision": lambda: resolver.resolve(revision="0" * 40),
            "corrupt": lambda: AssetResolver(
                manifest_path=corrupt_manifest_path,
                cache_root=cache_root,
            ).resolve(asset_root=assets.root),
            "style_identity": lambda: resolver.load_styles(assets, (invalid_style_path,)),
        }
        rejections = {}
        for name, check in checks.items():
            try:
                check()
            except AssetResolutionError as error:
                rejections[name] = error.code
            else:
                rejections[name] = "UNEXPECTED_SUCCESS"

        expected = {
            "missing": "MODEL_NOT_FOUND",
            "wrong_revision": "MODEL_INCOMPATIBLE",
            "corrupt": "MODEL_CORRUPT",
            "style_identity": "STYLE_MISMATCH",
        }
        result.update(
            {
                "model": {
                    "id": assets.model_id,
                    "revision": assets.revision,
                    "sample_rate": assets.sample_rate,
                },
                "graph_count": len(assets.graph_paths),
                "indexer_length": len(assets.unicode_indexer),
                "network_connect_attempts": attempts,
                "preset_shapes": {
                    "ttl": list(official.ttl.shape),
                    "dp": list(official.dp.shape),
                },
                "controlled_rejections": rejections,
                "stale_state": {
                    "first": float(first.ttl[0, 0, 0]),
                    "second": float(second.ttl[0, 0, 0]),
                    "cache_entries": resolver.cached_style_count,
                },
            }
        )
        if (
            attempts != 0
            or rejections != expected
            or result["stale_state"]["second"] != 0.98750001192092896
        ):
            exit_code = 1
finally:
    socket.socket.connect = original_connect
    if resource_path.exists():
        resource_path.unlink()
    shutil.rmtree(work_dir)
    result["cleanup"] = {
        "resources_removed": not resource_path.exists(),
        "scratch_removed": not work_dir.exists(),
    }
artifact_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")

if exit_code == 77:
    print("ASSETS_Q_MISSING")
elif exit_code == 0:
    print("ASSETS_Q_VERIFIED")
else:
    print("ASSETS_Q_FAILED")
raise SystemExit(exit_code)
"""


@dataclass(frozen=True, slots=True)
class PythonAssetsResult:
    """Describe the child result without granting an inference claim."""

    children: tuple[ChildExecution, ...]
    errors: tuple[str, ...]
    evidence_class: EvidenceClass
    outcome: Outcome
    inference_proof: bool


def run(root: str, run_dir: str, scratch_dir: str) -> PythonAssetsResult:
    """Execute the verified local-cache resolver probe in the Python project environment."""
    child = execute_child(
        (
            "uv",
            "run",
            "--project",
            f"{root}/py",
            "--extra",
            "cpu",
            "--extra",
            "dev",
            "python",
            "-c",
            _SCRIPT,
            root,
            run_dir,
            scratch_dir,
        ),
        _TIMEOUT_SECONDS,
    )
    if child.exit_code == 0 and child.stdout.strip() == _SUCCESS_MARKER:
        return PythonAssetsResult(
            children=(child,),
            errors=(),
            evidence_class="preflight",
            outcome="verified",
            inference_proof=False,
        )
    if child.exit_code == _MISSING_PREREQUISITE_EXIT and child.stdout.strip() == _MISSING_MARKER:
        return PythonAssetsResult(
            children=(child,),
            errors=("verified Python asset cache is unavailable",),
            evidence_class="preflight",
            outcome="missing_prerequisite",
            inference_proof=False,
        )
    return PythonAssetsResult(
        children=(child,),
        errors=("Python assets conformance child did not produce the verified marker",),
        evidence_class="preflight",
        outcome="assertion_failure",
        inference_proof=False,
    )
