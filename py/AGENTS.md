# PYTHON RUNTIME KNOWLEDGE BASE

## OVERVIEW
Locally installable compatibility SDK around the legacy ONNX implementation. Score: 9; separate package boundary, dependency extras, and public API.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Lightweight imports | supertonic_runtime/__init__.py | Public names; defers legacy inference imports |
| Existing inference | supertonic_runtime/_legacy.py | TextToSpeech, Style, UnicodeProcessor, chunk_text |
| Typed requests | supertonic_runtime/types.py | RuntimeConfig, SynthesisRequest, defaults |
| Public errors | supertonic_runtime/errors.py | ProviderUnavailableError and request validation |
| Asset integration | supertonic_runtime/assets.py | Python asset boundary |
| Compatibility imports | helper.py | Forwarder, not a second inference implementation |
| Console command | supertonic_runtime/cli.py | Validates arguments; does not synthesize |
| Direct ONNX example | example_onnx.py | Existing inference demonstration |
| External PyPI example | example_pypi.py | Uses separately distributed supertonic SDK |
| Regression tests | tests/test_package.py, tests/test_assets.py | Package and asset behavior |

## CONVENTIONS
- Distribution name: supertonic-runtime-local; import name: supertonic_runtime.
- Console entry point: supertonic-runtime; do not confuse it with external supertonic.
- Base dependencies include NumPy; ONNX Runtime is selected through extras.
- cpu pins onnxruntime 1.23.1; cuda pins onnxruntime-gpu 1.23.2.
- serve adds supertonic 1.3.1 and CPU ONNX Runtime; cpu/cuda and serve/cuda conflict.
- Keep ordinary public-package imports lightweight; inference loading is explicit.
- Only missing onnxruntime is translated to ProviderUnavailableError at the loader boundary.
- helper.py deliberately imports the legacy implementation eagerly for compatibility.
- Ruff targets Python 3.10, 100-column lines, and E/F/I/UP rules.
- basedpyright has an explicit include list; a passing check does not cover every legacy file.

## COMMANDS
Run inside py:

```sh
uv sync --extra cpu --extra dev
uv run pytest
uv run ruff check .
uv run basedpyright
uv run supertonic-runtime --text "Hello"
```

Inference prerequisites and example flags are documented in README.md.
The local CLI accepts --text, --language, --steps, and --speed; success only proves request validation.

## ANTI-PATTERNS
- Do not move eager ONNX imports into the lightweight package boundary.
- Do not duplicate _legacy.py behavior in helper.py.
- Do not represent example_pypi.py or the serve extra as this repository's own HTTP implementation.
- Do not claim synthesis or hardware support from successful package import or CLI validation.
