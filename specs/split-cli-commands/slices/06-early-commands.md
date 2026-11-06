# 06: Early commands

**Question:** Can the no-vault branch of `run()` become plain table lookups?

**Seam:** `src/commands/` files for `setup` (with `setupCommand`), `telemetry`, `feedback` (with `feedbackCommand`), `agent`, `context`, `update`.

**Check:** Gate, plus `grep -cE 'if \(command === "(setup|telemetry|feedback|agent|context|update)"' src/cli.ts` prints 0.

**Must stay green:** Every test; the golden check. `brain context` must still print nothing and exit 0 on any error (invariant 11).

**Decided:**
- `context` keeps its own catch-all so it never fails, whatever the router does.

**Delegated to the worker:**
- File grouping.

**Out of scope:**
- Changing what any of these commands do.
