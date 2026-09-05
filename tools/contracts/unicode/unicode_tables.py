from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Final

import unicodedata2
from typing_extensions import override

SCALAR_MAX: Final = 0x10FFFF
SURROGATE_START: Final = 0xD800
SURROGATE_END: Final = 0xDFFF
UNICODE_VERSION: Final = "15.1.0"


@dataclass(frozen=True, slots=True)
class GeneratorError(Exception):
    """A deterministic source or artifact contract violation."""

    message: str

    @override
    def __str__(self) -> str:
        return self.message


@dataclass(frozen=True, slots=True)
class Range:
    """One inclusive scalar range carrying a Unicode property value."""

    start: int
    end: int
    value: str

    def as_json(self) -> list[int | str]:
        """Serialize using the public scalar-safe interval format."""
        return [self.start, self.end, self.value]


def validate_scalar(scalar: int) -> int:
    """Reject non-scalars so generated tables cannot encode UTF-16 surrogates."""
    if 0 <= scalar <= SCALAR_MAX and not SURROGATE_START <= scalar <= SURROGATE_END:
        return scalar
    raise GeneratorError(f"non-scalar code point U+{scalar:04X}")


def is_surrogate(scalar: int) -> bool:
    """Return whether a Unicode code point is excluded from scalar-safe tables."""
    return SURROGATE_START <= scalar <= SURROGATE_END


def parse_scalar_range(field: str) -> tuple[int, int]:
    """Parse one UCD scalar or scalar range field."""
    first, separator, last = field.partition("..")
    start = validate_scalar(int(first, 16))
    end = validate_scalar(int(last, 16)) if separator else start
    if end < start:
        raise GeneratorError(f"descending scalar range {field}")
    return start, end


def data_lines(path: Path) -> list[str]:
    """Return non-comment UCD records while treating every comment as inert data."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise GeneratorError(f"cannot read source {path.name}: {error}") from error
    return [line.partition("#")[0].strip() for line in text.splitlines() if line.partition("#")[0].strip()]


def merged_ranges(ranges: list[Range]) -> list[Range]:
    """Sort and merge adjacent same-value ranges for compact deterministic output."""
    ordered = sorted(ranges, key=lambda item: (item.start, item.end, item.value))
    result: list[Range] = []
    for current in ordered:
        if result and result[-1].value == current.value and result[-1].end + 1 >= current.start:
            previous = result[-1]
            result[-1] = Range(previous.start, max(previous.end, current.end), previous.value)
        else:
            result.append(current)
    return result


def parse_property_ranges(path: Path, property_name: str, value: str | None = None) -> list[Range]:
    """Parse one UCD property file into sparse public intervals."""
    ranges: list[Range] = []
    for line in data_lines(path):
        fields = [field.strip() for field in line.split(";")]
        if len(fields) < 2:
            raise GeneratorError(f"malformed UCD record in {path.name}: {line}")
        start, end = parse_scalar_range(fields[0])
        if fields[1] != property_name:
            continue
        entry_value = value if value is not None else fields[2] if len(fields) >= 3 else ""
        if not entry_value:
            raise GeneratorError(f"missing value for {property_name} in {path.name}")
        ranges.append(Range(start, end, entry_value))
    return merged_ranges(ranges)


def parse_grapheme_break_ranges(path: Path) -> list[Range]:
    """Parse GraphemeBreakProperty records with their property values."""
    ranges: list[Range] = []
    for line in data_lines(path):
        fields = [field.strip() for field in line.split(";")]
        if len(fields) != 2:
            raise GeneratorError(f"malformed GCB record in {path.name}: {line}")
        start, end = parse_scalar_range(fields[0])
        if not fields[1]:
            raise GeneratorError(f"missing GCB value in {path.name}")
        ranges.append(Range(start, end, fields[1]))
    return merged_ranges(ranges)


def parse_unicode_data(path: Path) -> tuple[list[list[int]], list[list[int]]]:
    """Produce sparse direct decompositions and nonzero CCC values validated by unicodedata2."""
    if unicodedata2.unidata_version != UNICODE_VERSION:
        raise GeneratorError(
            f"unicodedata2 version mismatch: expected {UNICODE_VERSION}, got {unicodedata2.unidata_version}",
        )
    mappings: list[list[int]] = []
    combining: list[list[int]] = []
    for line in data_lines(path):
        fields = line.split(";")
        if len(fields) != 15:
            raise GeneratorError(f"malformed UnicodeData record: {line}")
        raw_scalar = int(fields[0], 16)
        if is_surrogate(raw_scalar):
            continue
        scalar = validate_scalar(raw_scalar)
        decomposition_tokens = fields[5].split()
        direct = [int(token, 16) for token in decomposition_tokens if not token.startswith("<")]
        for mapped_scalar in direct:
            _ = validate_scalar(mapped_scalar)
        library_tokens = unicodedata2.decomposition(chr(scalar)).split()
        library_direct = [int(token, 16) for token in library_tokens if not token.startswith("<")]
        if direct != library_direct:
            raise GeneratorError(f"unicodedata2 decomposition mismatch at U+{scalar:04X}")
        if direct:
            mappings.append([scalar, *direct])
        combining_class = int(fields[3])
        if combining_class != unicodedata2.combining(chr(scalar)):
            raise GeneratorError(f"unicodedata2 combining-class mismatch at U+{scalar:04X}")
        if combining_class:
            combining.append([scalar, combining_class])
    return mappings, combining
