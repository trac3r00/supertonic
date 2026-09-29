# Portable-runtime Unicode 15.1 artifacts

`generate.py` emits the three versioned contract files into `contracts/v1/` from vendored, hash-pinned Unicode 15.1 source bytes. Run it only through its isolated dependency set:

```sh
uv run --python 3.11 --with click==8.1.7 --with typer==0.15.2 --with unicodedata2==15.1.0 \
  tools/contracts/unicode/generate.py --output-dir contracts/v1
```

The generator never uses the host `unicodedata` database. It requires `unicodedata2==15.1.0`, verifies every file listed in `sources/source-lock.json` before staging output, and writes the table manifest last. Consumers must treat `unicode-manifest.json` as the commit marker and verify both hashes before using either table.

## `contracts/v1/normalization.json`

```text
format: "supertonic.unicode.normalization.v1"
unicode_version: "15.1.0"
normalization_form: "NFKD"
decomposition_mode: "direct_recursive"
scalar_range: [0, 1114111]
decomposition_mappings: [[source_scalar, [direct_mapping_scalar, ...]], ...]
canonical_combining_classes: [[scalar, nonzero_ccc], ...]
hangul: { algorithm: "UAX15_NFKD", s_base, s_count, l_base, l_count,
          v_base, v_count, t_base, t_count, n_count }
```

Mappings are sparse **direct** UCD decompositions. A consumer implements NFKD by recursively expanding table entries, then canonical-ordering adjacent non-starter scalars using `canonical_combining_classes`. Every table value is a Unicode scalar: `0..0x10FFFF`, excluding `0xD800..0xDFFF`. Hangul syllables are intentionally absent from `decomposition_mappings`; use the supplied UAX #15 constants algorithmically.

## `contracts/v1/grapheme.json`

```text
format: "supertonic.unicode.grapheme.v1"
unicode_version: "15.1.0"
uax29_revision: 43
segmentation: "UAX29_extended_grapheme_cluster"
range_format: "[start_scalar,end_scalar,value]"
properties: {
  Grapheme_Cluster_Break: [[start, end, gcb_value], ...],
  Extended_Pictographic: [[start, end, "Yes"], ...],
  Indic_Conjunct_Break: [[start, end, "Consonant"|"Extend"|"Linker"], ...]
}
rules: [{ id, rule }, ...]
```

Intervals are sorted, inclusive, non-overlapping sparse ranges. Missing values resolve to `Other` for `Grapheme_Cluster_Break`, `No` for `Extended_Pictographic`, and `None` for `Indic_Conjunct_Break`. Apply UAX #29 extended-grapheme rules GB3–GB13 and GB999, including GB9c (Indic conjuncts) and GB11 (emoji ZWJ sequences); do not segment UTF-16 code units.

## `contracts/v1/unicode-manifest.json`

The manifest records `unicode_version`, `uax29_revision`, the exact generator dependency, Unicode License V3 notice, every pinned source `{file,url,sha256}`, and `generated_files` SHA-256s for both table files. It contains no timestamps, absolute paths, or machine-specific state.

## Source license and regeneration safety

Vendored inputs are unmodified Unicode public data files. `sources/LICENSE-Unicode-3.0.txt` contains Unicode License V3 and `sources/NOTICE.md` explains provenance. On a source mismatch, malformed record, stale output, or the test-only pre-publication interruption hook, the generator exits nonzero before publishing a new manifest. `--verify-output` independently checks the manifest hashes and rejects a misleading prior success message or a missing/stale table.

`--verify-output` additionally verifies the selected source lock and source bytes,
reconstructs both expected tables in memory with the pinned generator, and compares
canonical bytes. Rehashing a modified mapping, CCC, Hangul constant, or grapheme
property cannot satisfy this fidelity check. Verification is read-only and never
repairs a corrupted artifact. Run the focused regression with
`node --test tools/contracts/unicode/verify-fidelity.test.mjs`.

### Coherent Python 3.11 typing

Run all five Python files with the local import-resolution configuration:

```sh
uv run --python 3.11 --with click==8.1.7 --with pydantic==2.10.6 \
  --with typer==0.15.2 --with unicodedata2==15.1.0 --with basedpyright \
  basedpyright --project tools/contracts/unicode/pyrightconfig.json \
  --pythonversion 3.11 --outputjson \
  tools/contracts/unicode/generate.py tools/contracts/unicode/unicode_tables.py \
  tools/contracts/unicode/artifact_models.py tools/contracts/unicode/test_generator.py \
  tools/contracts/unicode/test_grapheme_tables.py
```

The configuration only selects these files, Python 3.11, the repository import
root, and `typings/`. It does not change diagnostic severities. The narrow
`unicodedata2` stub describes only the version string and the two C-extension
functions used here; the real pinned extension remains the runtime oracle.
The tests parse JSON into typed structures with Pydantic rather than propagating
untyped JSON values. Include `--with pydantic==2.10.6` when running the Python
suite through `uv run ... python -m pytest`.
