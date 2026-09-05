from __future__ import annotations

from typing import ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field
from typing_extensions import TypedDict


class SourceEntry(BaseModel):
    """One hash-pinned official Unicode source record."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)
    file: str
    sha256: str
    url: str


class SourceLock(BaseModel):
    """Validated source-lock boundary for untrusted JSON bytes."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)
    format: Literal["supertonic.unicode.source-lock.v1"]
    unicode_version: Literal["15.1.0"]
    sources: tuple[SourceEntry, ...]


class GeneratedFiles(BaseModel):
    """The two files committed by one manifest marker."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    grapheme_json: str = Field(alias="grapheme.json")
    normalization_json: str = Field(alias="normalization.json")


class GeneratorSpec(BaseModel):
    """The fixed dependency and entrypoint that produced one artifact set."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)
    dependency: Literal["unicodedata2==15.1.0"]
    entrypoint: Literal["tools/contracts/unicode/generate.py"]


class ArtifactManifest(BaseModel):
    """The generated-file verification surface used by the CLI."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)
    format: Literal["supertonic.unicode.manifest.v1"]
    generated_files: GeneratedFiles
    generator: GeneratorSpec
    license_notice: str
    sources: tuple[SourceEntry, ...]
    uax29_revision: Literal[43]
    unicode_version: Literal["15.1.0"]




class NormalizationData(TypedDict):
    unicode_version: str
    normalization_form: str
    hangul: dict[str, str | int]
    decomposition_mappings: list[tuple[int, list[int]]]
    canonical_combining_classes: list[tuple[int, int]]


class RuleData(TypedDict):
    id: str
    rule: str


class GraphemeData(TypedDict):
    unicode_version: str
    segmentation: str
    properties: dict[str, list[tuple[int, int, str]]]
    rules: list[RuleData]


class ManifestData(TypedDict):
    unicode_version: str
    generated_files: dict[str, str]


class SourceData(TypedDict):
    file: str
    sha256: str
    url: str


class LockData(TypedDict):
    format: str
    unicode_version: str
    sources: list[SourceData]
