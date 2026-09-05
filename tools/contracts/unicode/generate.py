#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = [
#     "click==8.1.7",
#     "pydantic==2.10.6",
#     "typer==0.15.2",
#     "unicodedata2==15.1.0",
# ]
# ///

# ─── How to run ───
# 1. Install uv (if not installed):
#      curl -LsSf https://astral.sh/uv/install.sh | sh
# 2. Run directly (no venv, no pip install needed):
#      uv run --python 3.11 tools/contracts/unicode/generate.py --output-dir contracts/v1
# 3. Or make executable and run:
#      chmod +x tools/contracts/unicode/generate.py && ./tools/contracts/unicode/generate.py --output-dir contracts/v1
# ──────────────────

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Annotated, Final, TypeAlias

import typer
from pydantic import ValidationError

ROOT: Final = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.contracts.unicode.artifact_models import (
    ArtifactManifest,
    SourceEntry,
    SourceLock,
)
from tools.contracts.unicode.unicode_tables import (
    UNICODE_VERSION,
    GeneratorError,
    parse_grapheme_break_ranges,
    parse_property_ranges,
    parse_unicode_data,
)

DEFAULT_SOURCES: Final = ROOT / "tools/contracts/unicode/sources"
DEFAULT_OUTPUT: Final = ROOT / "contracts/v1"
ARTIFACTS: Final = ("normalization.json", "grapheme.json", "unicode-manifest.json")
UAX29_REVISION: Final = 43
JsonValue: TypeAlias = str | int | Sequence["JsonValue"] | Mapping[str, "JsonValue"]


def canonical_bytes(value: JsonValue) -> bytes:
    """Encode only stable ASCII JSON with no timestamps or host paths."""
    return (json.dumps(value, ensure_ascii=True, indent=2, sort_keys=True) + "\n").encode("ascii")


def digest(path: Path) -> str:
    """Compute the SHA-256 used by source and artifact manifests."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_lock(source_dir: Path) -> tuple[SourceEntry, ...]:
    """Read and validate the pinned relative source manifest."""
    lock_path = source_dir / "source-lock.json"
    try:
        lock = SourceLock.model_validate_json(lock_path.read_text(encoding="utf-8"))
    except OSError as error:
        raise GeneratorError(f"cannot read source lock: {error}") from error
    except ValidationError as error:
        raise GeneratorError(f"malformed source lock: {error}") from error
    for entry in lock.sources:
        if Path(entry.file).name != entry.file:
            raise GeneratorError("source-lock filename must be a plain relative name")
    return lock.sources


def verify_sources(source_dir: Path) -> tuple[SourceEntry, ...]:
    """Refuse changed or missing input bytes before creating any staged artifact."""
    entries = read_lock(source_dir)
    for entry in entries:
        path = source_dir / entry.file
        if not path.is_file():
            raise GeneratorError(f"missing pinned source {entry.file}")
        actual = digest(path)
        if actual != entry.sha256:
            raise GeneratorError(f"source digest mismatch for {entry.file}")
    return entries


def normalization_table(source_dir: Path) -> dict[str, JsonValue]:
    """Build recursive-compatible sparse direct NFKD and CCC tables."""
    mappings, combining = parse_unicode_data(source_dir / "UnicodeData.txt")
    return {
        "canonical_combining_classes": combining,
        "decomposition_mappings": [[entry[0], entry[1:]] for entry in mappings],
        "decomposition_mode": "direct_recursive",
        "format": "supertonic.unicode.normalization.v1",
        "hangul": {
            "algorithm": "UAX15_NFKD",
            "l_base": 0x1100,
            "l_count": 19,
            "n_count": 588,
            "s_base": 0xAC00,
            "s_count": 11172,
            "t_base": 0x11A7,
            "t_count": 28,
            "v_base": 0x1161,
            "v_count": 21,
        },
        "normalization_form": "NFKD",
        "scalar_range": [0, 0x10FFFF],
        "unicode_version": UNICODE_VERSION,
    }


def grapheme_table(source_dir: Path) -> dict[str, JsonValue]:
    """Build sparse UAX29 extended-grapheme property intervals from pinned UCD data."""
    gcb = parse_grapheme_break_ranges(source_dir / "GraphemeBreakProperty.txt")
    pictographic = parse_property_ranges(source_dir / "emoji-data.txt", "Extended_Pictographic", "Yes")
    incb = parse_property_ranges(source_dir / "DerivedCoreProperties.txt", "InCB")
    return {
        "format": "supertonic.unicode.grapheme.v1",
        "properties": {
            "Extended_Pictographic": [item.as_json() for item in pictographic],
            "Grapheme_Cluster_Break": [item.as_json() for item in gcb],
            "Indic_Conjunct_Break": [item.as_json() for item in incb],
        },
        "range_format": "[start_scalar,end_scalar,value]",
        "rules": [
            {"id": "GB3", "rule": "CR x LF"},
            {"id": "GB4", "rule": "(Control|CR|LF) break"},
            {"id": "GB5", "rule": "break (Control|CR|LF)"},
            {"id": "GB6", "rule": "L x (L|V|LV|LVT)"},
            {"id": "GB7", "rule": "(LV|V) x (V|T)"},
            {"id": "GB8", "rule": "(LVT|T) x T"},
            {"id": "GB9", "rule": "x (Extend|ZWJ)"},
            {"id": "GB9a", "rule": "x SpacingMark"},
            {"id": "GB9b", "rule": "Prepend x"},
            {"id": "GB9c", "rule": "InCB=Consonant (Extend|Linker)* Linker (Extend|Linker)* x InCB=Consonant"},
            {"id": "GB11", "rule": "Extended_Pictographic Extend* ZWJ x Extended_Pictographic"},
            {"id": "GB12", "rule": "RI x RI when preceding RI count is odd"},
            {"id": "GB13", "rule": "RI x RI when preceding RI count is odd"},
            {"id": "GB999", "rule": "break otherwise"},
        ],
        "segmentation": "UAX29_extended_grapheme_cluster",
        "uax29_revision": UAX29_REVISION,
        "unicode_version": UNICODE_VERSION,
    }


def verify_artifacts(output_dir: Path) -> None:
    """Verify the manifest commit marker instead of trusting a success message."""
    manifest_path = output_dir / "unicode-manifest.json"
    if not manifest_path.is_file():
        raise GeneratorError("missing generated file unicode-manifest.json")
    try:
        manifest = ArtifactManifest.model_validate_json(manifest_path.read_text(encoding="utf-8"))
    except ValidationError as error:
        raise GeneratorError(f"malformed generated manifest: {error}") from error
    expected_files = (
        ("normalization.json", manifest.generated_files.normalization_json),
        ("grapheme.json", manifest.generated_files.grapheme_json),
    )
    for filename, expected in expected_files:
        path = output_dir / filename
        if not path.is_file():
            raise GeneratorError(f"missing generated file {filename}")
        if digest(path) != expected:
            raise GeneratorError(f"stale generated file {filename}")


def publish(output_dir: Path, staged: dict[str, bytes], force: bool) -> None:
    """Stage all files then publish tables before their manifest commit marker."""
    existing = [output_dir / filename for filename in ARTIFACTS if (output_dir / filename).exists()]
    if existing and not force:
        try:
            verify_artifacts(output_dir)
        except GeneratorError as error:
            raise GeneratorError(f"stale generated output: {error}; use --force") from error
        raise GeneratorError("generated output already exists; use --force")
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".unicode-stage-", dir=output_dir.parent))
    try:
        for filename, content in staged.items():
            _ = (staging / filename).write_bytes(content)
        if os.environ.get("SUPERTONIC_UNICODE_TEST_INTERRUPT_BEFORE_PUBLISH") == "1":
            raise GeneratorError("interrupted before publish")
        output_dir.mkdir(parents=True, exist_ok=True)
        for filename in ("normalization.json", "grapheme.json", "unicode-manifest.json"):
            os.replace(staging / filename, output_dir / filename)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def generate(source_dir: Path, output_dir: Path, force: bool) -> None:
    """Generate and publish one complete manifest-gated Unicode contract set."""
    sources = verify_sources(source_dir)
    normalization = normalization_table(source_dir)
    grapheme = grapheme_table(source_dir)
    normalization_bytes = canonical_bytes(normalization)
    grapheme_bytes = canonical_bytes(grapheme)
    manifest = {
        "format": "supertonic.unicode.manifest.v1",
        "generated_files": {
            "grapheme.json": hashlib.sha256(grapheme_bytes).hexdigest(),
            "normalization.json": hashlib.sha256(normalization_bytes).hexdigest(),
        },
        "generator": {
            "dependency": "unicodedata2==15.1.0",
            "entrypoint": "tools/contracts/unicode/generate.py",
        },
        "license_notice": "Unicode License V3; see tools/contracts/unicode/sources/LICENSE-Unicode-3.0.txt",
        "sources": [{"file": source.file, "sha256": source.sha256, "url": source.url} for source in sources],
        "uax29_revision": UAX29_REVISION,
        "unicode_version": UNICODE_VERSION,
    }
    publish(
        output_dir,
        {
            "normalization.json": normalization_bytes,
            "grapheme.json": grapheme_bytes,
            "unicode-manifest.json": canonical_bytes(manifest),
        },
        force,
    )
    verify_artifacts(output_dir)


app = typer.Typer(add_completion=False, no_args_is_help=True)


@app.command()
def main(
    sources_dir: Annotated[Path, typer.Option("--sources-dir")] = DEFAULT_SOURCES,
    output_dir: Annotated[Path, typer.Option("--output-dir")] = DEFAULT_OUTPUT,
    force: Annotated[bool, typer.Option("--force")] = False,
    verify_output: Annotated[bool, typer.Option("--verify-output")] = False,
) -> None:
    """Generate or verify deterministic Unicode 15.1 portable-runtime artifacts."""
    try:
        if verify_output:
            verify_artifacts(output_dir)
            _ = verify_sources(sources_dir)
            expected_tables = (
                ("normalization.json", normalization_table(sources_dir)),
                ("grapheme.json", grapheme_table(sources_dir)),
            )
            for filename, expected_table in expected_tables:
                if (output_dir / filename).read_bytes() != canonical_bytes(expected_table):
                    raise GeneratorError(f"Unicode 15.1 fidelity mismatch for {filename}")
            typer.echo(f"verified {output_dir}")
        else:
            generate(sources_dir, output_dir, force)
            typer.echo(f"generated {output_dir}")
    except GeneratorError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(code=2) from error


if __name__ == "__main__":
    app()
