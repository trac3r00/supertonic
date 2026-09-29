# TOOLING KNOWLEDGE BASE

## OVERVIEW
Asset integrity, portable-contract conformance, Unicode generation, and evidence tooling. Score: 14; several independently configured tooling domains under one subtree.

## STRUCTURE
- assets/: Node asset-cache CLI, manifest validation, download/publication logic, regressions.
- contracts/: Node contract checker and language-neutral validation library.
- contracts/unicode/: isolated Python generator, fidelity tests, typing configuration.
- contracts/unicode/sources/: vendored, hash-pinned Unicode 15.1 inputs; not handwritten code.
- contracts/unicode/typings/: narrow unicodedata2 typing shim.
- validation/: separate strict Python evidence harness; read its AGENTS.md.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Asset commands | assets/cli.mjs | fetch, verify, inventory |
| Asset cache implementation | assets/cache.mjs | fetchManifest, verifyCache, inventoryCache |
| Model manifest shape | assets/manifest.mjs | Validation and source URL resolution |
| Contract checker | contracts/check.mjs | parseArgs and runChecker |
| Contract semantics | contracts/lib.mjs | Schemas, dependencies, fixtures, Unicode checks |
| Unicode generation | contracts/unicode/generate.py | Pinned source verification and publication |
| Unicode interpretation | contracts/unicode/unicode_tables.py | Source parsing and portable tables |
| Generator usage | contracts/unicode/README.md | Exact isolated dependencies and typing command |

## CONVENTIONS
- Node utilities are standalone .mjs modules, not part of the packages/js build.
- Contract checker tests live beside tools; interchange fixtures live at ../tests/fixtures/contracts.
- Generated Unicode artifacts are written to ../contracts/v1, not this subtree.
- Unicode inputs are locked by sources/source-lock.json; preserve the bundled license and NOTICE.
- The generator uses unicodedata2==15.1.0, not the host unicodedata database.
- unicode-manifest.json is the publication marker; consumers verify both table hashes.
- --verify-output reconstructs expected tables and compares canonical bytes without repairing files.
- Asset verify requires --offline; inventory and verify are separate from fetch.

## COMMANDS
Run from the repository root:

```sh
node tools/assets/cli.mjs --help
node tools/contracts/check.mjs --help
node --test tools/assets/test.mjs
node --test tools/contracts/check.test.mjs
node --test tools/contracts/unicode/verify-fidelity.test.mjs
```

Use contracts/unicode/README.md for the complete pinned uv invocation before regenerating tables.
Use validation/AGENTS.md for evidence-harness commands and limits.

## ANTI-PATTERNS
- Do not bless edited Unicode tables by merely recomputing their manifest hashes.
- Do not publish a new Unicode manifest before both tables are staged successfully.
- Do not replace vendored source bytes without updating provenance and hash locks together.
- Do not describe a fixture-only check as real ONNX inference or performance evidence.
