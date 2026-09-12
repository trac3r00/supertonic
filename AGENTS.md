# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-12T03:57:38.938Z
**Commit:** 6da8ebe
**Branch:** docs/init-deep-knowledge-base

## OVERVIEW
Supertonic is an on-device multilingual TTS repository: ONNX inference examples across languages, plus a portable-runtime contract, shared TypeScript core, Python compatibility SDK, and validation tooling. Model assets are external; the repository is not a single application or root workspace package.

## STRUCTURE
- contracts/v1/: normative contract, JSON schemas, model/dependency manifests, generated Unicode tables.
- packages/js/: environment-neutral TypeScript pipeline; separate from the nodejs and web examples.
- py/: direct ONNX examples and the locally installable supertonic_runtime compatibility package.
- nodejs/, web/: standalone Node and Vite/browser demonstrations.
- cpp/, csharp/, go/, java/, rust/, swift/: independently built native/CLI examples.
- flutter/, ios/: application examples; Flutter includes macOS scaffolding, iOS has an XcodeGen project.yml.
- tools/: asset cache, contract checking, Unicode generation, and evidence harness.
- tests/fixtures/contracts/: shared machine-consumed contract fixtures, not a root test runner.
- test_all.sh: interactive multi-language inference smoke script.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Portable behavior | contracts/v1/SPEC.md, contract.json | Normative rules versus implementation progress |
| Dependency/provider support | contracts/v1/dependencies.json | Also inspect each runtime's manifest/lock |
| Model artifact identity | contracts/v1/models/supertonic-3.json | Pinned asset manifest |
| Shared JS implementation | packages/js/AGENTS.md | Injected adapter pipeline, text, audio, lifecycle |
| Python API or compatibility | py/AGENTS.md | Lightweight API versus legacy implementation |
| Asset or contract tooling | tools/AGENTS.md | Cache commands, generated-data ownership |
| Receipts and baseline work | tools/validation/AGENTS.md | Evidence semantics and capture restrictions |
| Native inference changes | Each runtime's helper and example files | Implementations are duplicated, not generated ports |
| Browser demonstration | web/helper.js, web/main.js | Separate from packages/js/src/web.ts |
| Mobile UI | flutter/lib/, ios/ExampleiOSApp/ | Runtime-specific application integration |

## CODE MAP
| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| createPipelineEngine | Function | packages/js/src/pipeline.ts | Unmeasured | Shared engine admission, inference, close |
| InferenceAdapter | Interface | packages/js/src/types.ts | Unmeasured | Backend seam used by the shared pipeline |
| load_text_to_speech | Function | py/supertonic_runtime/__init__.py | Unmeasured | Deferred legacy inference loading |
| validateSchema | Function | tools/contracts/lib.mjs | 10 local | Recursive contract/schema validation |
| EvidenceRun | Class | tools/validation/src/supertonic_verify/runner.py | Unmeasured | Private evidence/resource lifecycle |

Map grounded in LSP outlines and AST import/export searches. LSP reference coverage was local/incomplete; unmeasured does not mean unused.

## CONVENTIONS
- There is no root package.json, universal build command, or single shared implementation for all examples.
- Each runtime owns dependency metadata and working-directory assumptions; read its README before running it.
- New portable behavior is defined in contracts/v1; old examples are not proof that every contract rule is implemented.
- Shared contract fixtures are language-neutral inputs; tests also live beside tooling and within packages.
- Source changes and generated contract data have separate ownership; see tools/AGENTS.md and packages/js/AGENTS.md.

## ANTI-PATTERNS (THIS PROJECT)
- Do not confuse normative contract requirements with completed runtime capabilities.
- Do not treat raw batch inference as long-form chunking; they are separate operations.
- Do not pad short model audio or infer duration from requested length; the contract uses valid sample counts.
- Do not silently fall back after model corruption or invalid input; contract provider fallback is explicit opt-in.
- Do not commit downloaded models, generated WAV results, or local toolchain/cache directories.

## UNIQUE STYLES
- Many language directories contain tracked assets symlinks to ../assets; clone/setup supplies the external target.
- CLI helpers are ports with similar names, but flags and list delimiters differ by runtime.
- Portable text behavior is pinned to Unicode 15.1 rather than each host's Unicode version.
- The external supertonic PyPI SDK and its HTTP server are distinct from this checkout's local SDK.

## COMMANDS
These are inference examples, not asset-free unit tests:

```sh
# Run from repository root; external assets and runtime tools are prerequisites.
(cd nodejs && npm install && node example_onnx.js)
bash test_all.sh
```

For scoped checks, use packages/js/AGENTS.md, py/AGENTS.md, and tools/AGENTS.md.

## NOTES
- README.md contains the July 2026 archive/support notice; preserve that context instead of promising ongoing upstream development.
- Missing assets prevent real inference even when package imports or contract checks pass.
- test_all.sh installs/builds runtimes, prompts for mode and optional result deletion, and does not exercise web/mobile applications.
- The root smoke script uses local caches and platform-specific toolchain fallbacks; it is not the canonical evidence CLI.
- Contract validation exit/evidence meanings are specified in contracts/v1/testing.md; baseline caveats are in tools/validation/BASELINE.md.
