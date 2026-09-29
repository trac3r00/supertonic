# Unicode 15.1 source notice

This directory vendors unmodified public Unicode Character Database 15.1.0 data files used to build the checked-in portable-runtime contract tables.

The files are governed by the Unicode License V3, vendored verbatim as `LICENSE-Unicode-3.0.txt`. Their upstream locations and SHA-256 digests are pinned in `source-lock.json`; the generator refuses a source whose digest differs from that lock.

The generator uses `unicodedata2==15.1.0` only to derive the Unicode 15.1 NFKD mapping and canonical combining-class tables. It does not consult the host Python `unicodedata` database.
