# VALIDATION HARNESS KNOWLEDGE BASE

## OVERVIEW
Python 3.11 evidence CLI with private receipts and bounded child execution. Score: 9; independently packaged strict harness with protocol-heavy behavior.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| CLI dispatch | src/supertonic_verify/cli.py | Typer app; implemented scenarios versus explicit refusals |
| Receipt/resource lifecycle | src/supertonic_verify/runner.py | EvidenceRun, child execution, cleanup, redaction |
| Machine-consumed shapes | src/supertonic_verify/models.py | Pydantic evidence models |
| Historical source setup | src/supertonic_verify/baseline.py | Original-source baseline support |
| Capture orchestration | src/supertonic_verify/capture_driver.py | Runs capture protocol |
| Protocol math | src/supertonic_verify/capture_protocol.py | Workload schedule and summaries |
| Child inference program | src/supertonic_verify/capture_program.py | Instrumented subprocess workload |
| Scenario entry points | src/supertonic_verify/scenarios/ | Baseline and Python asset integration |
| Baseline interpretation | BASELINE.md | Authorization, metrics, provenance, qualification limits |
| Tests | tests/test_runner.py, tests/test_capture_protocol.py | Dispatcher and protocol regressions |

## CONVENTIONS
- Canonical prefix: uv run --project tools/validation supertonic-verify (from repository root).
- Exit 0 means verified assertions; 1 means failed assertions; 2 means invalid or unimplemented invocation; 77 means missing prerequisites.
- Implemented evidence commands allocate a private run-* directory with receipt.json.
- Evidence keeps redacted/bounded diagnostics and cleanup proof, not secret-bearing replay commands.
- resources.json exists while resources are owned; cleanup.json records release and scratch cleanup.
- Models reject malformed evidence; absent/mismatched expected identities cannot pass.
- BASELINE.md distinguishes preparation from timed capture; do not infer timing from prepare.
- baseline defaults to capture; timed capture requires explicit authorization on a quiescent host.
- Baseline qualification is local POSIX Python CPU, not Windows or accelerator proof.
- pyproject.toml requires Python >=3.11,<3.12, strict basedpyright, Ruff ALL, and pytest warnings as errors.
- Run basedpyright with -p tools/validation so it selects this package's configuration.

## COMMANDS
Run from the repository root:

```sh
uv run --project tools/validation supertonic-verify --help
uv run --project tools/validation pytest tools/validation/tests
uv run --project tools/validation ruff check tools/validation/src tools/validation/tests
uv run --project tools/validation ruff format --check tools/validation/src tools/validation/tests
uv run --project tools/validation basedpyright -p tools/validation
```

## ANTI-PATTERNS
- Do not run baseline with an omitted --scenario as a harmless smoke test.
- Do not treat advertised --help commands as implemented scenarios; inspect dispatch first.
- Do not conflate process-cold and system-cold measurements or startup with warm inference.
- Do not label historical-to-control changes as code-only speedups; dependencies/interpreters differ.
- Do not weaken strict diagnostics or omit cleanup/identity evidence to obtain a passing receipt.
