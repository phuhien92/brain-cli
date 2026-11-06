# 07: Thin router

**Question:** Is `cli.ts` now only parsing, vault discovery, output, and exit codes, under 500 lines?

**Seam:** HELP to `src/commands/help.ts`; `cli.ts` keeps `main`, the parse half of `run`, the table, `fail`, `findVault`, `locateVault`, telemetry wiring, and the re-exports.

**Check:** Gate, plus `test $(wc -l < src/cli.ts) -lt 500`.

**Must stay green:** Every test; the golden check.

**Decided:**
- If it can't reach 500 without moving router code, stop and report the remaining budget instead.

**Delegated to the worker:**
- Small tidy-ups inside `cli.ts` that change no behaviour.

**Out of scope:**
- The after-scorecard: run `/codebase-rubric` once this lands (informational).
