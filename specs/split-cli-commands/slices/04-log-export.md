# 04: Log and export

**Question:** Does the largest block (`log`, 170 lines) move whole, including the code that reassigns `index`?

**Seam:** `src/commands/log.ts` (and `export.ts` if grouping helps): `log`, `export`, `resolveLogEntry`, `runExports`, `formatExports`, `driftMessage`.

**Check:** Gate, plus `node --no-warnings=ExperimentalWarning --test dist/test/log.test.js` passes.

**Must stay green:** Every test; the golden check.

**Decided:**
- A handler that refreshes the index updates it through the vault context, so the router's telemetry still sees the right counts.

**Delegated to the worker:**
- File grouping of `export` with `log`.

**Out of scope:**
- Changes to `src/log.ts`.
