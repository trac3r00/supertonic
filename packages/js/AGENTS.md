# JAVASCRIPT RUNTIME KNOWLEDGE BASE

## OVERVIEW
Environment-neutral TypeScript pipeline, not an ONNX adapter implementation. Score: 12; distinct publishable package with its own tooling and public exports.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Public API | src/index.ts, src/types.ts | Barrel exports plus adapter/engine interfaces |
| Engine lifecycle | src/pipeline.ts | createPipelineEngine; admission, loading, cancellation, close |
| Model-stage orchestration | src/inference.ts | Injected InferenceAdapter owns backend operations |
| Request validation | src/request.ts | Zod boundary and preset/default handling |
| Text preparation | src/unicode.ts, src/unicode-data.ts | Portable normalization and chunking |
| Audio assembly | src/pcm.ts, src/result.ts | Sample accounting, WAV conversion, materialization |
| Copied contract data | scripts/build.ts, scripts/data-integrity.ts | Copy, hash, compile, verify |
| Tests | tests/core.test.ts, tests/lifecycle-cases.ts | Core and lifecycle cases |
| Export checks | tests/exports.test.ts | Built package entry points |

## CONVENTIONS
- Relative TypeScript imports use emitted .js extensions; module resolution is NodeNext.
- Strict settings include exactOptionalPropertyTypes and noUncheckedIndexedAccess.
- Biome uses two spaces, double quotes, 100 columns, and semicolons only as needed.
- Export named declarations; separate type-only imports.
- Supply backend behavior through InferenceAdapter rather than importing a runtime into the core.
- src/node.ts, web.ts, worker.ts, and http.ts currently only re-export core and a RUNTIME_TARGET marker.
- src/cli.ts currently exposes round-samples only; it is not a speech synthesis CLI.

## DATA OWNERSHIP
- scripts/build.ts replaces src/data and dist from ../../contracts/v1 and compiler output.
- The build copies contract.json, both Unicode tables, their manifest, and models/supertonic-3.json.
- dist/data/source-hashes.json records source hashes; data-integrity.ts verifies shipped bytes.
- Edit authoritative contracts or build logic, not copied src/data JSON.

## COMMANDS
Run inside packages/js:

```sh
bun install --frozen-lockfile
bun run check
bun test
```

check rebuilds first, verifies copied data, then runs Biome and TypeScript.

## ANTI-PATTERNS
- Do not describe the environment entry points as completed Node/browser/Worker/HTTP integrations.
- Do not hand-edit dist or treat generated src/data as independent contract authority.
- Biome rejects explicit any, non-null assertions, default exports, and parameter reassignment.
