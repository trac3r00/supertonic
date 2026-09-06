"""Console entry point for the lightweight package boundary."""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from typing import Final

from .errors import RequestValidationError
from .types import DEFAULT_SPEED, DEFAULT_STEPS, SynthesisRequest

DESCRIPTION: Final = "Supertonic Runtime local SDK"


class _Arguments(argparse.Namespace):
    """Typed destination populated by argparse's declared converters."""

    text: str = ""
    language: str = "en"
    steps: int = DEFAULT_STEPS
    speed: float = DEFAULT_SPEED


def main(argv: Sequence[str] | None = None) -> int:
    """Validate a request without loading optional inference dependencies."""
    parser = argparse.ArgumentParser(description=DESCRIPTION)
    _ = parser.add_argument("--text", default="")
    _ = parser.add_argument("--language", default="en")
    _ = parser.add_argument("--steps", type=int, default=DEFAULT_STEPS)
    _ = parser.add_argument("--speed", type=float, default=DEFAULT_SPEED)
    arguments = parser.parse_args(argv, namespace=_Arguments())
    try:
        _ = SynthesisRequest(arguments.text, arguments.language, arguments.steps, arguments.speed)
    except RequestValidationError as error:
        parser.error(str(error))
    return 0
