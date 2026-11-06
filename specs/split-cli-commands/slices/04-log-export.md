# 04: Log and export

**Question:** Does the largest block (`log`, 170 lines) move whole, including the code that reassigns `index`?

**Seam:** `src/commands/log.ts` (and `export.ts` if grouping helps): `log`, `export`, `resolveLogEntry`, `runExports`, `formatExports`, `driftMessage`.

**Check:** Gate, plus `node --no-warnings=ExperimentalWarning --test dist/test/log.test.js` passes.

**Must stay green:** Every test; the golden check.

**Decided:**
- A handler that refreshes the index keeps its own copy of the stats. The router's telemetry counts are taken before the handler runs, so they don't depend on it. (Corrected after the third decisions ledger; the user can revisit.)

**Delegated to the worker:**
- File grouping of `export` with `log`.

**Out of scope:**
- Changes to `src/log.ts`.
