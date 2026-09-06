# Validation command contract

`uv run --project tools/validation supertonic-verify` is the canonical
validation command prefix (`Q`) for portable-runtime work.

## Exit statuses

- `0`: verified assertion set.
- `1`: assertion failure; a receipt records the exact rejected condition.
- `2`: invalid invocation, unknown runtime, or documented-but-unimplemented
  scenario. This is never a skip or a mock success.
- `77`: a real prerequisite is absent, so the requested claim is unverified.

## Evidence receipt

Every implemented command requiring `--evidence DIR` writes one private
`DIR/run-*/receipt.json`. The receipt records the literal child argv, real
child exit status, bounded/redacted diagnostics, source revision and dirty
worktree state, model-manifest and dependency-lock hashes, an explicit
`null` corpus hash when no corpus was supplied, host/interpreter identity,
timestamps, and cleanup proof. A supplied expected hash must match exactly;
missing or mismatched identities cannot pass.

Child argv are executed unchanged in memory, but the persisted `argv` is a
bounded, redacted command identity, not a replayable copy of secret-bearing
arguments. Receipt commands and assertion diagnostics are redacted too.
An existing file or otherwise unusable evidence destination is refused with
exit `2` and bounded `invalid_invocation` stderr, without echoing the path or
overwriting the file. No receipt is claimed when no safe destination exists.

The runtime scratch directory and loopback ephemeral port are allocated per
run. `resources.json` exists only while the scenario owns resources. Cleanup
removes it, writes `cleanup.json`, removes scratch, and retains only redacted
logs plus the canonical receipt.

## Task 3 scenarios

`preflight` implements:

- `missing-assets`: exits `77` with a missing-prerequisite receipt.
- `receipt-fixture`: runs fixed local child argv for success, exit `23`, and
  timeout. It proves dispatcher behavior only.
- `reject-nonfinite-status` and `reject-missing-receipt`: exit `1` after
  rejecting invalid receipt input.

Fixture receipts always set `evidence_class="harness_fixture"`,
`inference_proof=false`, and an empty `claimable_for` list. They are never
TTS, hardware, model, or performance proof.

All other Q command names appear in `--help` but exit `2` until their owning
task implements an explicit real scenario. Task 4 owns `baseline`.
