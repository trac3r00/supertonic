# Supertonic portable runtime contract v1

This directory is the normative, language-neutral boundary for every runtime. `contract.json` is machine-consumed; schemas define interchange shapes; conformance fixtures pin observable behavior. Runtime helpers may delegate to idiomatic APIs but may not weaken these rules.

## API and results

An engine supports create/load, single synthesis, one raw bounded inference batch, long-form owned chunk iteration, capability reporting, and idempotent close/dispose. Raw batch is never long-form chunking. Materialized results contain mono float32 PCM, sample rate, valid sample count and count-derived duration per item, request ID, and effective model/provider/quality metadata. PCM16 clamping belongs only to WAV encoding.

## Inputs, text, and limits

Validate supported language and the 16,384-raw-scalar ceiling before normalization. The exact language set, defaults, presets, expression tags, numeric ranges, and 32-item SDK versus 64-item compatibility HTTP boundaries are in `contract.json`. Explicit steps override a requested preset; resource profiles do not alter speech semantics.

Normalize with the checked-in Unicode 15.1 NFKD tables, then apply the compatible replacement and emoji filtering rules. Preserve recognized `<laugh>`, `<breath>`, and `<sigh>` tokens as indivisible units. Inject language wrappers after chunk accounting. Reject unsupported normalized scalars and text empty after preprocessing. Segment sentence-first, then whitespace, then Unicode 15.1 extended grapheme clusters. Budgets are 120 normalized scalars for Korean/Japanese and 300 otherwise. A recognized tag or grapheme cluster that alone exceeds a smaller explicit budget is `RESOURCE_EXHAUSTED`; no truncation is allowed.

## Audio, lifecycle, errors, and providers

Only actual, valid samples are retained. Never pad a short model output or read beyond it. Insert exactly `round(sample_rate * silence_seconds)` zeros once between emitted chunks. Streaming owns each finite chunk, exposes sequence/final metadata, and retains at most two chunk buffers; materialization enforces its 3,600-second ceiling.

One request runs per engine by default. Service admission is bounded at `2 * worker_count`. Close cancels queued work, requests cooperative cancellation, waits before releasing native sessions, is idempotent, and makes later calls fail with `ENGINE_CLOSED`. Cancellation is polled at the stages listed in `contract.json`; in-flight native interruption is not universally promised.

Public errors validate against `schemas/error.schema.json`. Provider fallback requires explicit opt-in for an unavailable selection, a compatible dtype, and a reported cause. Model corruption and input errors never trigger fallback. Capabilities report configured and actual execution truth, not requested intent.

## Resource profiles and reproducibility

Profiles only bound workers, threads, initialization, spinning, and admission. They are not speech-quality presets and application admission is not represented as a hard total-process/VRAM guarantee. Seeds are repeatable only within a runtime/backend; cross-port comparisons inject the same reference float32 noise through a test-only seam that cannot bypass ordinary validation.
