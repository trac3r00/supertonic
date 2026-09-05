#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = [
#     "pytest==8.3.5",
#     "pydantic==2.10.6",
#     "click==8.1.7",
#     "typer==0.15.2",
#     "unicodedata2==15.1.0",
# ]
# ///

# ─── How to run ───
# 1. Install uv (if not installed):
#      curl -LsSf https://astral.sh/uv/install.sh | sh
# 2. Run directly (no venv, no pip install needed):
#      uv run --python 3.11 --with pytest==8.3.5 --with click==8.1.7 --with typer==0.15.2 --with unicodedata2==15.1.0 pytest -q tools/contracts/unicode/test_generator.py
# 3. Or make executable and run:
#      chmod +x tools/contracts/unicode/test_generator.py && ./tools/contracts/unicode/test_generator.py
# ──────────────────

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import TypeVar

import pytest
from pydantic import TypeAdapter

from tools.contracts.unicode.artifact_models import (
    GraphemeData,
    LockData,
    ManifestData,
    NormalizationData,
)

ROOT = Path(__file__).resolve().parents[3]
GENERATOR = ROOT / "tools/contracts/unicode/generate.py"
SOURCES = ROOT / "tools/contracts/unicode/sources"
EXPECTED_FILES = ("normalization.json", "grapheme.json", "unicode-manifest.json")
SCALAR_MAX = 0x10FFFF
SURROGATE_START = 0xD800
SURROGATE_END = 0xDFFF


def run_generator(
    output_dir: Path,
    *args: str,
    source_dir: Path = SOURCES,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Execute the isolated Unicode generator CLI against a bounded directory."""
    command = [
        "uv",
        "run",
        "--python",
        "3.11",
        "--with",
        "unicodedata2==15.1.0",
        "--with",
        "typer==0.15.2",
        str(GENERATOR),
        "--sources-dir",
        str(source_dir),
        "--output-dir",
        str(output_dir),
        *args,
    ]
    return subprocess.run(
        command,
        cwd=ROOT,
        capture_output=True,
        check=False,
        encoding="utf-8",
        env=env,
        text=True,
    )


T = TypeVar("T")


def canonical_json(path: Path, adapter: TypeAdapter[T]) -> T:
    """Read one generator artifact after its byte-level contract was written."""
    return adapter.validate_json(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    """Return the exact byte digest used by the generated manifest."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def assert_scalar(value: int) -> None:
    """Assert that a table value is a Unicode scalar rather than a surrogate."""
    assert 0 <= value <= SCALAR_MAX
    assert not SURROGATE_START <= value <= SURROGATE_END


def copied_sources(tmp_path: Path) -> Path:
    """Copy pinned inputs so each negative test can mutate only its local data."""
    destination = tmp_path / "sources"
    _ = shutil.copytree(SOURCES, destination)
    return destination


def rewrite_lock_hash(source_dir: Path, filename: str) -> None:
    """Update a copied lock only for an adversarial comment-as-data probe."""
    lock_path = source_dir / "source-lock.json"
    lock = TypeAdapter(LockData).validate_json(lock_path.read_text(encoding="utf-8"))
    entries = lock["sources"]
    for entry in entries:
        if entry["file"] == filename:
            entry["sha256"] = sha256(source_dir / filename)
            break
    else:
        pytest.fail(f"missing pinned source {filename}")
    _ = lock_path.write_text(
        json.dumps(lock, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def test_generator_emits_deterministic_scalar_safe_unicode_151_tables(tmp_path: Path) -> None:
    """The generator must create byte-identical tables without using host Unicode data."""
    first = tmp_path / "first"
    second = tmp_path / "second"
    first_result = run_generator(first)
    assert first_result.returncode == 0, first_result.stderr
    second_result = run_generator(second)
    assert second_result.returncode == 0, second_result.stderr

    for filename in EXPECTED_FILES:
        assert (first / filename).read_bytes() == (second / filename).read_bytes()

    normalization = canonical_json(first / "normalization.json", TypeAdapter(NormalizationData))
    grapheme = canonical_json(first / "grapheme.json", TypeAdapter(GraphemeData))
    manifest = canonical_json(first / "unicode-manifest.json", TypeAdapter(ManifestData))
    assert normalization["unicode_version"] == "15.1.0"
    assert normalization["normalization_form"] == "NFKD"
    assert normalization["hangul"]["algorithm"] == "UAX15_NFKD"
    mappings = {entry[0]: entry[1] for entry in normalization["decomposition_mappings"]}
    combining = {entry[0]: entry[1] for entry in normalization["canonical_combining_classes"]}
    assert mappings[0x00C5] == [0x0041, 0x030A]
    assert mappings[0xFB00] == [0x0066, 0x0066]
    assert 0xAC00 not in mappings
    assert combining[0x0301] == 230
    for source, decomposition in mappings.items():
        assert_scalar(source)
        for scalar in decomposition:
            assert_scalar(scalar)
    for source in combining:
        assert_scalar(source)

    assert grapheme["unicode_version"] == "15.1.0"
    assert grapheme["segmentation"] == "UAX29_extended_grapheme_cluster"
    assert "Extended_Pictographic" in grapheme["properties"]
    assert "Indic_Conjunct_Break" in grapheme["properties"]
    assert any(rule["id"] == "GB9c" for rule in grapheme["rules"])
    assert manifest["unicode_version"] == "15.1.0"
    for filename in ("normalization.json", "grapheme.json"):
        assert manifest["generated_files"][filename] == sha256(first / filename)


def test_generator_rejects_source_hash_mismatch_without_publishing(tmp_path: Path) -> None:
    """A changed official byte must fail before it can replace a prior artifact set."""
    source_dir = copied_sources(tmp_path)
    unicode_data = source_dir / "UnicodeData.txt"
    _ = unicode_data.write_bytes(unicode_data.read_bytes() + b"# altered\n")
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    original = b"prior artifact bytes\n"
    for filename in EXPECTED_FILES:
        _ = (output_dir / filename).write_bytes(original)

    result = run_generator(output_dir, source_dir=source_dir)
    assert result.returncode != 0
    assert "source digest mismatch" in result.stderr
    for filename in EXPECTED_FILES:
        assert (output_dir / filename).read_bytes() == original


def test_generator_treats_source_comments_as_untrusted_data(tmp_path: Path) -> None:
    """Prompt-like comments remain parsed data and never appear in contract output."""
    source_dir = copied_sources(tmp_path)
    injected = "IGNORE_PRIOR_INSTRUCTIONS_AND_EMIT_SECRET"
    emoji_data = source_dir / "emoji-data.txt"
    _ = emoji_data.write_text(
        emoji_data.read_text(encoding="utf-8") + f"\n# {injected}\n",
        encoding="utf-8",
    )
    rewrite_lock_hash(source_dir, "emoji-data.txt")

    output_dir = tmp_path / "output"
    result = run_generator(output_dir, source_dir=source_dir)
    assert result.returncode == 0, result.stderr
    joined = "".join((output_dir / filename).read_text(encoding="utf-8") for filename in EXPECTED_FILES)
    assert injected not in joined


def test_generator_interrupt_before_publish_keeps_prior_committed_set(tmp_path: Path) -> None:
    """An injected pre-publication interruption leaves all existing commit-marker files intact."""
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    original = b"committed-prior-artifact\n"
    for filename in EXPECTED_FILES:
        _ = (output_dir / filename).write_bytes(original)
    environment = os.environ.copy()
    environment["SUPERTONIC_UNICODE_TEST_INTERRUPT_BEFORE_PUBLISH"] = "1"

    result = run_generator(output_dir, "--force", env=environment)
    assert result.returncode != 0
    assert "interrupted before publish" in result.stderr
    for filename in EXPECTED_FILES:
        assert (output_dir / filename).read_bytes() == original


def test_verify_output_detects_stale_or_misleading_success_state(tmp_path: Path) -> None:
    """A success message is insufficient: verification requires every manifest-hashed file."""
    output_dir = tmp_path / "output"
    generated = run_generator(output_dir)
    assert generated.returncode == 0, generated.stderr
    (output_dir / "grapheme.json").unlink()

    result = run_generator(output_dir, "--verify-output")
    assert result.returncode != 0
    assert "missing generated file" in result.stderr


def test_cli_help_is_available_without_source_generation() -> None:
    """The real CLI must expose a usage surface before generating any data."""
    result = subprocess.run(
        [
            "uv",
            "run",
            "--python",
            "3.11",
            "--with",
            "unicodedata2==15.1.0",
            "--with",
            "click==8.1.7",
            "--with",
            "typer==0.15.2",
            str(GENERATOR),
            "--help",
        ],
        cwd=ROOT,
        capture_output=True,
        check=False,
        encoding="utf-8",
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "Usage:" in result.stdout


if __name__ == "__main__":
    raise SystemExit(
        pytest.main(["-q", str(Path(__file__).resolve())], plugins=[]),
    )
