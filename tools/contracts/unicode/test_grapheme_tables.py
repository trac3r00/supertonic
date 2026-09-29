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
#      uv run --python 3.11 --with pytest==8.3.5 --with click==8.1.7 --with typer==0.15.2 --with unicodedata2==15.1.0 pytest -q tools/contracts/unicode/test_grapheme_tables.py
# 3. Or make executable and run:
#      chmod +x tools/contracts/unicode/test_grapheme_tables.py && ./tools/contracts/unicode/test_grapheme_tables.py
# ──────────────────

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from pydantic import TypeAdapter

from tools.contracts.unicode.artifact_models import GraphemeData
from tools.contracts.unicode.unicode_tables import GeneratorError, parse_scalar_range, parse_unicode_data

ROOT = Path(__file__).resolve().parents[3]
GENERATOR = ROOT / "tools/contracts/unicode/generate.py"
SOURCES = ROOT / "tools/contracts/unicode/sources"


def generate(output_dir: Path) -> None:
    """Generate a fresh grapheme table with the isolated production CLI."""
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
            "--sources-dir",
            str(SOURCES),
            "--output-dir",
            str(output_dir),
        ],
        cwd=ROOT,
        capture_output=True,
        check=False,
        encoding="utf-8",
        text=True,
    )
    assert result.returncode == 0, result.stderr


def property_at(ranges: list[tuple[int, int, str]], scalar: int, default: str) -> str:
    """Resolve one scalar with the sparse sorted interval contract."""
    for start, end, value in ranges:
        assert isinstance(start, int)
        assert isinstance(end, int)
        assert isinstance(value, str)
        if start <= scalar <= end:
            return value
    return default


def has_gb9c_left_context(incb: list[str], boundary: int) -> bool:
    """Recognize the left side of UAX29 GB9c before one boundary."""
    index = boundary - 1
    saw_linker = False
    while index >= 0 and incb[index] in {"Extend", "Linker"}:
        if incb[index] == "Linker":
            saw_linker = True
        index -= 1
    return saw_linker and index >= 0 and incb[index] == "Consonant"


def has_gb11_left_context(gcb: list[str], pictographic: list[bool], boundary: int) -> bool:
    """Recognize Extended_Pictographic Extend* ZWJ before one boundary."""
    index = boundary - 1
    if index < 0 or gcb[index] != "ZWJ":
        return False
    index -= 1
    while index >= 0 and gcb[index] == "Extend":
        index -= 1
    return index >= 0 and pictographic[index]


def is_break(
    gcb: list[str],
    pictographic: list[bool],
    incb: list[str],
    boundary: int,
) -> bool:
    """Apply UAX29 revision 43 extended-grapheme rules at one scalar boundary."""
    left = gcb[boundary - 1]
    right = gcb[boundary]
    if left == "CR" and right == "LF":
        return False
    if left in {"Control", "CR", "LF"} or right in {"Control", "CR", "LF"}:
        return True
    if left == "L" and right in {"L", "V", "LV", "LVT"}:
        return False
    if left in {"LV", "V"} and right in {"V", "T"}:
        return False
    if left in {"LVT", "T"} and right == "T":
        return False
    if right in {"Extend", "ZWJ", "SpacingMark"} or left == "Prepend":
        return False
    if incb[boundary] == "Consonant" and has_gb9c_left_context(incb, boundary):
        return False
    if pictographic[boundary] and has_gb11_left_context(gcb, pictographic, boundary):
        return False
    if left == "Regional_Indicator" and right == "Regional_Indicator":
        preceding = 0
        index = boundary - 1
        while index >= 0 and gcb[index] == "Regional_Indicator":
            preceding += 1
            index -= 1
        return preceding % 2 == 0
    return True


def breaks_for(text: str, grapheme: GraphemeData) -> list[int]:
    """Segment one text strictly from generated data, never host Unicode properties."""
    properties = grapheme["properties"]
    assert isinstance(properties, dict)
    gcb_ranges = properties["Grapheme_Cluster_Break"]
    pictographic_ranges = properties["Extended_Pictographic"]
    incb_ranges = properties["Indic_Conjunct_Break"]
    assert isinstance(gcb_ranges, list)
    assert isinstance(pictographic_ranges, list)
    assert isinstance(incb_ranges, list)
    scalars = [ord(character) for character in text]
    gcb = [property_at(gcb_ranges, scalar, "Other") for scalar in scalars]
    pictographic = [property_at(pictographic_ranges, scalar, "No") == "Yes" for scalar in scalars]
    incb = [property_at(incb_ranges, scalar, "None") for scalar in scalars]
    boundaries = [0]
    for boundary in range(1, len(scalars)):
        if is_break(gcb, pictographic, incb, boundary):
            boundaries.append(boundary)
    boundaries.append(len(scalars))
    return boundaries


def parse_official_case(line: str) -> tuple[str, list[int]]:
    """Parse one official UAX29 GraphemeBreakTest line into text and expected boundaries."""
    tokens = line.partition("#")[0].split()
    assert tokens[0] == "÷"
    scalars: list[int] = []
    boundaries: list[int] = []
    for index in range(1, len(tokens), 2):
        marker = tokens[index - 1]
        if marker == "÷":
            boundaries.append(len(scalars))
        scalars.append(int(tokens[index], 16))
    assert tokens[-1] == "÷"
    boundaries.append(len(scalars))
    return "".join(chr(scalar) for scalar in scalars), boundaries


def test_scalar_range_rejects_surrogate_interior() -> None:
    with pytest.raises(GeneratorError, match="non-scalar"):
        _ = parse_scalar_range("D7FF..E000")
    assert parse_scalar_range("E000..E001") == (0xE000, 0xE001)


def test_unicode_data_surrogate_records_are_excluded() -> None:
    mappings, combining = parse_unicode_data(SOURCES / "UnicodeData.txt")
    assert all(not 0xD800 <= entry[0] <= 0xDFFF for entry in (*mappings, *combining))


def test_generated_tables_pass_every_official_grapheme_break_case(tmp_path: Path) -> None:
    """All official Unicode 15.1 UAX29 vectors must segment from the generated tables."""
    output_dir = tmp_path / "output"
    generate(output_dir)
    grapheme = TypeAdapter(GraphemeData).validate_json((output_dir / "grapheme.json").read_text(encoding="utf-8"))
    cases = 0
    for line in (SOURCES / "GraphemeBreakTest.txt").read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        text, expected = parse_official_case(line)
        assert breaks_for(text, grapheme) == expected, line
        cases += 1
    assert cases > 500


def test_generated_tables_apply_indic_conjunct_break_rule(tmp_path: Path) -> None:
    """GB9c must retain Devanagari consonant-linker-consonant as one grapheme."""
    output_dir = tmp_path / "output"
    generate(output_dir)
    grapheme = TypeAdapter(GraphemeData).validate_json((output_dir / "grapheme.json").read_text(encoding="utf-8"))
    assert breaks_for("क्\u200dक", grapheme) == [0, 4]
