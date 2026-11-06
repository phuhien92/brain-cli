# 02: Handler shape

**Question:** Does one handler shape serve both a command that needs no vault and one that does, with output unchanged?

**Seam:** `src/commands/shared.ts` (`Out`, `CliError`, `print`, the handler type, the context type) and the name→handler table in `cli.ts`. Moves `path` (no vault) to `src/commands/path.ts` and `view` (vault) to `src/commands/view.ts`. The router opens the vault context (today's preamble at `cli.ts:540-558`) and closes it.

**Check:** Gate, plus `grep -cE 'command === "path"|case "view"' src/cli.ts` prints 0.

**Must stay green:** Every test; the golden check.

**Decided:**
- Handler: `(args, flags, ctx) => Promise<number>`. `ctx` carries `out`, `bin`, `report({context, error})`, and an optional `vault` (vault, cfg, scope, store, index).
- Handlers throw; only the router calls `fail()`.
- Nothing in `src/commands/` imports `cli.ts`.

**Delegated to the worker:**
- Exact context field names.

**Out of scope:**
- Every other command.
