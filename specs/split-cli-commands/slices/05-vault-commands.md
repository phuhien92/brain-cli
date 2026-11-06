# 05: Remaining vault commands

**Question:** Do the remaining vault commands fit the shape, with the test import of `extractSections` still resolving?

**Seam:** `src/commands/` files for `ingest`, `index`, `search`, `get` (with `formatMeta`, `extractSections`, `stem`), `sync`, `lifecycle` (with `brief`, `staleMark`), `lint` (with `formatFindings`), `integrations`, `doctor` (with the `doctor` checks). `cli.ts` re-exports `extractSections`.

**Check:** Gate, plus `grep -c 'switch (command)' src/cli.ts` prints 0.

**Must stay green:** Every test; the golden check.

**Decided:**
- `cli.ts` re-exports every symbol a test imports from it.

**Delegated to the worker:**
- File grouping and where `brief`, `staleMark`, and `formatFindings` live.

**Out of scope:**
- Reslice into two if this slice's diff gets hard to review (search/get/lint vs the rest).
