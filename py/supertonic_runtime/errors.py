"""Typed exceptions exposed by the runtime package."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

PROVIDER_UNAVAILABLE: Final = "PROVIDER_UNAVAILABLE"


@dataclass(frozen=True, slots=True)
class RuntimeErrorBase(Exception):
    """Base exception with a stable public error code."""

    code: str
    message: str

    def __post_init__(self) -> None:
        """Initialize the standard exception message from typed fields."""
        Exception.__init__(self, f"{self.code}: {self.message}")


@dataclass(frozen=True, slots=True)
class ProviderUnavailableError(RuntimeErrorBase):
    """Raised when optional inference dependencies are not installed."""

    code: str = PROVIDER_UNAVAILABLE
    message: str = "Install supertonic-runtime-local[cpu] before requesting inference."


@dataclass(frozen=True, slots=True)
class RequestValidationError(RuntimeErrorBase):
    """Raised when a lightweight public request DTO is invalid."""

    code: str = "INVALID_REQUEST"
    message: str = "Invalid synthesis request."
