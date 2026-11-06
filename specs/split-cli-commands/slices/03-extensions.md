# 03: Extensions

**Question:** Do the extension runner and `ext` behave the same from outside `cli.ts`: child processes, timeouts, the binary path, and the `extension_failed` telemetry error?

**Seam:** `src/commands/ext.ts`: `ext`, `extensionManagementCommand`, `confirmExtensionInstall`, `runExtensionCommand`, `killExtensionTree`, `extensionInvocation`, and the extension constants. The pre-parse extension dispatch in `run()` stays in the router and calls into it.

**Check:** Gate, plus `node --no-warnings=ExperimentalWarning --test dist/test/extensions.test.js` passes all its tests (18 at the time of the split; the plan's "16" was a drafting estimate).

**Must stay green:** Every test; the golden check.

**Decided:**
- The binary path comes from `ctx.bin`, never recomputed from the moved file's location.
- Extensions still dispatch before strict `parseArgs`, and built-in commands still win over an extension of the same name.

**Delegated to the worker:**
- Whether `commandPosition` stays in the router or moves (it serves dispatch, so the router is the default).

**Out of scope:**
- Moving the runner into `src/extensions.ts` (#26).
