# Original-source baseline harness

`prepare` exercises the capture worker once and retains numerical/audio references.
It is preparation evidence, not a timing baseline. `capture` (also the baseline
command's default scenario) executes the complete protocol and must not be run
until the parent explicitly authorizes 4B on a quiescent host.

```sh
uv run --project tools/validation supertonic-verify baseline --ref 104e2ec154823b0e296076f98016de9b3b41cfe5 --scenario prepare --evidence .omo/evidence/task-4A/prepare
# Only following explicit 4B authorization:
uv run --project tools/validation supertonic-verify baseline --ref 104e2ec154823b0e296076f98016de9b3b41cfe5 --scenario capture --evidence .omo/evidence/task-4B
```

For each fixed English short/medium/long workload, each of three repeats launches
three cold Python processes (one synthesis each), then one fresh Python process
that loads once, performs one excluded warmup, and executes twenty warm requests
on that same engine. Total: 36 inference processes, 207 measured requests, nine
excluded warmups. Environment sync/build is outside all process measurements.
The protocol does not flush the OS/filesystem cache. Process-cold is not system-cold.

Original source and historical dependencies come from `104e2ec…`. The separately
retained control catalog, pyproject, and lock come from committed `1058e919…`, not
live sibling-edited files. Control definitions are frozen, not executed. No
historical-to-control speedup is attributable solely to code. The historical
interpreter is explicitly CPython 3.13.14; resolution, interpreter hash, native
binding hashes, host and effective ORT session settings are recorded per child.

Each request resets the original NumPy RNG to seed 41024 and saves actual noise
and mask per chunk, plus float32 NPY PCM and losslessly decoded float WAV. Voice
M1, English, eight steps, speed 1.05, silence 0.3, CPUExecutionProvider and original
model precision remain fixed. Copying noise/masks is instrumentation included in
synthesis latency; serialization is excluded. Do not compare against an
uninstrumented candidate as a code-only speedup.

Times are monotonic nanoseconds. `load_ns` covers model/style loading.
`synthesis_ns` covers the original helper call. Per-request events also retain
child-entry-to-PCM-ready time. Parent `process_launch_to_exit_ns` includes Python
startup, imports, loading, requests, serialization and teardown, but not `uv sync`.
RSS is process-lifetime high water in bytes (Darwin bytes; Linux KiB converted).
Audio duration uses actual sample count/44100, and RTF uses synthesis seconds over
that duration. Nearest-rank p50/p95 are grouped by workload/repeat/cold-or-warm;
separate process/load summaries prevent conflating startup with warm inference.

`tests/test_capture_protocol.py` uses synthetic scheduling/arithmetic fixtures,
including an injected process executor. Its output is never performance evidence.
Other-language and physical-platform baselines remain deferred pending actual
assessment. This driver currently qualifies only the local POSIX Python CPU
path, not Windows or accelerator runtimes. No future optimization `bench`
comparison is implemented here.

Canonical strict checks from the repository root:

```sh
uv run --project tools/validation ruff check tools/validation/src tools/validation/tests
uv run --project tools/validation ruff format --check tools/validation/src tools/validation/tests
uv run --project tools/validation basedpyright -p tools/validation
```

The explicit `-p` selects this package's strict configuration instead of a
root/default configuration. `py.typed` marks the installed src-layout package as
typed; no diagnostic rules are weakened or suppressed.
