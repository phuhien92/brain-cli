# Decisions: split-cli-commands

# Check 1: slice 01 (commit 5390bbf, golden.sh + golden/)

Run by `decision-checker` in Check mode with no user present (rule 7): the baseline is this spec (`README.md` plus `slices/01-golden-capture.md`), every confidence is capped at medium, and the ledger was saved without asking. No implementer report was available beyond the commit message, so the trace below is the checker's own. The fixture notes and the exact command list beyond the minimum were delegated to the worker and are not judged here, except where the list misses the slice's own stated minimum.

Ran: `npm run compile`, then `golden.sh check` twice: no output, exit 0 both times. The commit touches only `specs/split-cli-commands/` (no `src/`, `test/` or `dist/` change), so the 149 tests are unaffected by this slice; `npm test` was not rerun. Probes ran against throwaway vaults outside the repo and were deleted.

## Check these first

1. **`log`, `lifecycle` and `view` are recorded only as usage errors** (unsound, low)
2. **Exit codes 1 and 7 are reachable but not recorded** (unsound, low)
3. **Trailing newlines are invisible to the check** (unsound, low)

## needs-you

### The machine name (this host's hostname) is baked into the recordings

- **When:** 5390bbf, `golden/24-sync-none-json.txt`
- **Slice:** 01
- **What happens now:** `brain sync --json` reports `"machine":"vm"`, which brain takes from the hostname when no machine name is configured. The script clears the environment with `env -i` and does not set `BRAIN_MACHINE`, and the normalizer leaves the value alone. Run `golden.sh check` on any other machine (a laptop, CI) and that case fails although the code did not change. The obvious alternative pins `BRAIN_MACHINE=golden` in the fixture environment, so the recording no longer depends on where it was made.
- **The gap:** the slice said "normalize only what differs run to run" and listed what to disable, but said nothing about values that differ machine to machine.
- **Reach:** harmless while every slice is checked on this machine. Anyone who checks out the branch elsewhere, or a later CI gate, gets a false failure and may learn to ignore the check.
- **Verdict:** needs-you. Portability was never stated as a requirement. **Recommended call:** add `BRAIN_MACHINE=golden` to the `env -i` line and recapture once (this pins an input; it does not normalize output). **To reverse:** drop the variable and recapture.
- **Confidence:** medium.

## unsound

### `log`, `lifecycle` and `view` are recorded only as usage errors

- **When:** 5390bbf, cases `14-view`, `15-log-list-json`, `16-lifecycle-json`
- **Slice:** 01
- **What happens now:** the slice's minimum coverage names `view`, `log list` and `lifecycle`. The script runs `brain view` (no kind), `brain log list --json` and `brain lifecycle --json`. All three exit 2 with a usage message: `log list` is not a real subcommand (`brain log [n]` lists), and the other two lack a required argument. So the only thing recorded for these commands is their usage string. The working output, the part slice 04 ("Does the largest block move whole?") and slice 05 will move, is never captured: a probe showed `brain log --json`, `brain view learning --json` and `brain lifecycle status --json` all succeed on a plain vault. The obvious alternative records each named command's success output, with log entries in the fixture (`log add` before `log`), plus the usage error as an extra case. Covering those would also expose a normalizer gap: `lifecycle status` prints `"today":"2026-11-06"`, a date-only value the ISO-timestamp rule does not catch, and `log add` writes generated entry IDs, which the slice said to normalize but the script has no rule for.
- **The gap:** the slice listed command names but not that it meant their normal output, and the fixture design was left to the worker.
- **Reach:** the log block is the largest single move in the split. With only usage strings recorded, a regression in `log` listing, `view` rendering or `lifecycle status` passes the golden gate and is caught only if a test happens to assert that field.
- **Verdict:** unsound. The minimum is met by name only. **Redo from:** every command the slice names has at least one recorded case that exits 0 with real output from a fixture that exercises it (log entries, a lifecycle note, a view kind), and the normalizer covers the run-to-run values those cases print (today's date, generated entry IDs) and nothing more.
- **Confidence:** low.

### Exit codes 1 and 7 are reachable but not recorded

- **When:** 5390bbf, case list
- **Slice:** 01
- **What happens now:** the slice asks for "one error case per exit code the fixture can reach". The commit records 0, 2, 3 and 4. Exit 1 needs no fixture at all: a probe running `brain search x --json` outside any vault exits 1 with `no_vault`. Exit 7 needs one broken link: a probe with `[[missing-note]]` and `lint --strict --json` exits 7 with `lint_failed`. Exits 5 (export found unrecorded edits) and 6 (outside an integration's scope) need a little config but no network either. Because the worker also designed the fixture, the fixture's reach was set by the same call that skipped the cases. The obvious alternative adds a no-vault case and a broken-link note, and tries 5 and 6 with a local export path and an integration.
- **The gap:** "the fixture can reach" left the fixture's breadth to the worker without saying the fixture should reach the codes the CLI documents.
- **Reach:** error mapping and exit codes stay in the router (`cli.ts`) while handlers start throwing (decided in planning). That is exactly where a refactor can turn one exit code into another, and the golden check would not notice for 1, 5, 6 or 7.
- **Verdict:** unsound. A thin fixture satisfies the wording, not the intent. **Redo from:** each documented exit code that needs no network or git remote (1, 2, 3, 4, 5, 6, 7) has a recorded case, or the ledger names why one cannot be reached locally.
- **Confidence:** low.

### Trailing newlines are invisible to the check

- **When:** 5390bbf, `golden.sh` `run_case`
- **Slice:** 01
- **What happens now:** stdout is captured with `stdout=$(...)` and stderr with `stderr=$(cat ...)`. Shell command substitution strips every trailing newline, so output ending in `a\n`, `a\n\n` or `a` produces the same recording. A handler moved during the split that switches `console.log(x)` to `process.stdout.write(x)` (losing the final newline), or prints an extra blank line at the end, passes the check. The obvious alternative writes stdout and stderr straight to files and records those bytes, so the diff sees them.
- **The gap:** the slice said the check fails "if any byte or exit code changes"; it did not say how to capture, and the worker picked a capture that drops bytes.
- **Reach:** every later slice relies on this gate to claim byte-identical output. The newline at the end of output is one of the likeliest things a move from inline `if` blocks to handler functions changes, and agents and pipes (`brain log | head`) do see it.
- **Verdict:** unsound. The check does not meet its own stated property. **Redo from:** the recording holds stdout and stderr byte for byte, including trailing newlines, and a one-newline change makes `check` exit 1.
- **Confidence:** low.

### The spec's "Next agent prompt" still says nothing is built

- **When:** 5390bbf (README not touched)
- **Slice:** 01
- **What happens now:** `README.md` ends with "Status: planned, nothing built. Start with 01." and the instruction "Update this prompt before you end." The slice 01 commit does not change it. A fresh agent picking up the branch reads that it should start with 01 and may re-run `golden.sh capture` over the recordings. The obvious alternative updates the status in the same commit (01 done, how to run the gate, next is 02).
- **The gap:** none really: the spec says to update it. The worker may intend to do it after this check.
- **Reach:** every handoff between slices goes through this prompt.
- **Verdict:** unsound if the worker ends without it. **Redo from:** the README's next-agent prompt reflects what is built before the next slice starts.
- **Confidence:** medium.

## sound

### Only per-run values are normalized: temp paths, the state-folder hash, ISO timestamps, `ms` and `mtime`

- **When:** 5390bbf, `golden.sh` sed rules
- **Slice:** 01
- **What happens now:** each recording replaces the temp folder with `<TMP>`, `vault-<12 hex>` (the state folder named from a hash of the temp vault path) with `vault-<ID>`, full ISO timestamps with `<TIME>`, and the `ms` and `mtime` JSON fields with `<N>`. Search scores, counts, ordering and messages are left as they are, so a change there fails the check. The obvious alternative, normalizing more broadly or comparing parsed JSON, would hide real changes.
- **The gap:** the slice said "temp vault path, timestamps, and generated IDs"; the state hash, mtimes and timings are the same kind of value.
- **Reach:** later slices inherit a strict check. Three timing keys in the rule (`durationMs`, `took`, `elapsedMs`) appear in no recording; harmless but dead.
- **Verdict:** sound. Matches the slice's rule; see the unsound entry above for values that new cases would need.
- **Confidence:** medium.

### The fixture runs in an emptied environment with CI on and stdout not a terminal

- **When:** 5390bbf, `run_case`
- **Slice:** 01
- **What happens now:** each case runs under `env -i` with only `PATH`, a temp `HOME`, a temp `BRAIN_STATE_DIR`, `BRAIN_NO_UPDATE_CHECK=1`, `BRAIN_TELEMETRY=0`, `BRAIN_VAULT=""` and `CI=1`, inside the temp vault. The user's own config, vault and state cannot leak in. The cost: terminal-only paths (the telemetry question, the update notice, interactive `ext install`) are never recorded. The obvious alternative, running under a pseudo-terminal, would make captures far less stable.
- **The gap:** the slice said to disable the update check and telemetry, not how much else to strip.
- **Reach:** terminal-only behaviour stays covered by the tests only, which matches the slice's out-of-scope list in spirit.
- **Verdict:** sound.
- **Confidence:** medium.

### One text file per case; `capture` deletes and rewrites the whole folder; `check` diffs the folder

- **When:** 5390bbf, `golden.sh` and `golden/`
- **Slice:** 01
- **What happens now:** each case is one file holding the command line, exit code, stdout and stderr. `capture` removes `golden/` and writes it again, so a renamed or dropped case leaves no stale file. `check` runs `diff -ru` and prints the diff with temp paths replaced, exiting 1 on any difference, including a missing or extra case. The obvious alternative, separate files per stream, is harder to review in a PR.
- **The gap:** the slice named the folder, not the layout.
- **Reach:** reviewers can read a golden change as an ordinary diff.
- **Verdict:** sound.
- **Confidence:** medium.

### Cases share one vault and run in a fixed order

- **When:** 5390bbf, case list
- **Slice:** 01
- **What happens now:** all 27 cases run against the same temp vault in order. `path` runs before any index exists (so it records "not created yet"), `index` builds it, and later cases record `"unchanged":4`. Reordering cases changes recordings, which the script's comment states. The obvious alternative, a fresh vault per case, would record the first-index counts everywhere and miss the "already indexed" path.
- **The gap:** fixture design was delegated; ordering was not discussed.
- **Reach:** a future case that writes to the vault (for example `log add`) changes every later recording; put such cases last or in their own vault.
- **Verdict:** sound.
- **Confidence:** medium.

### The check runs the compiled `dist/`, not `src/`

- **When:** 5390bbf, `golden.sh` header
- **Slice:** 01
- **What happens now:** the script runs `bin/brain.js`, which imports `dist/src/cli.js`, with the same `--no-warnings=ExperimentalWarning` flag the binary's own shebang uses. If someone edits `src/` and forgets to compile, the check tests stale code. The gate runs `npm test` (which builds) before it, so in the gate's order this is safe. The obvious alternative, compiling inside the script, would write `dist/` as a side effect of a check.
- **The gap:** the slice said "runs `node bin/brain.js`".
- **Reach:** run the gate in its stated order.
- **Verdict:** sound.
- **Confidence:** medium.

Trivial naming (case file names `NN-name[-json].txt`, `<TMP>`, `<ID>`, `<N>`, `<TIME>` placeholders): 1 line, not listed.

## Pattern

Four of the five non-sound entries sit in one area: what the golden check actually proves. The slice gave command names and a "byte-identical" goal, and the build met the names with the thinnest fixture. Worth sending back through the spec as one tightened check line ("each named command records a success case; each local exit code has a case; capture is byte-exact") rather than rechecking the same kind of call on every slice.

## Next step

Before slice 02 starts, redo the golden capture from the three low-confidence entries (byte-exact capture, success cases for `log`, `view`, `lifecycle status`, cases for exit 1 and 7 and, if reachable, 5 and 6) and recapture; the code under test has not changed yet, so this is the cheapest moment to widen the net.

# Check 2: slice 02 (commits 030ddec, ea9b3ed)

Run by `decision-checker` in Check mode with no user present (rule 7): the baseline is this spec (`README.md` plus `slices/02-handler-shape.md`), every confidence is capped at medium, and the ledger was saved without asking. The only implementer report is the two commit messages. Exact context field names were delegated to the worker (slice 02), as were the homes of shared helpers (README), so they are judged only where they change behaviour.

Ran at ea9b3ed: `npm run compile`, then `golden.sh check` (no diff, exit 0); `grep -l '\.\./cli' src/commands/*.ts` (nothing); `git diff --stat 5390bbf..ea9b3ed -- test/` (empty); the slice check grep (0). `npm test` ran three times: `# pass 148`, `# fail 1` each time. `package.test.js` "a global install from a git URL" fails every run because `node_modules` in this worktree is a symlink and `cpSync` refuses to copy it. That is the check's environment, not slice 02. One run also failed `lifecycle.test.js` "log retire and replace…" (empty stdout); it passed 6 of 6 times alone and in the other two full runs, so it looks flaky under load, but it does call `view`, so watch it. `dist/` was restored afterwards. Probes ran outside the repo and were deleted.

## Check 1 entries: did 030ddec fix them?

- **Machine name baked in:** fixed. `BRAIN_MACHINE=golden` is pinned, and so is `BRAIN_TODAY=2026-01-15`.
- **`log`, `lifecycle`, `view` only as usage errors:** mostly fixed. There are success cases for `log add`, `log`, `view decision` and `lifecycle status`, and log file dates are normalized. Still open: `lifecycle status` records `"notes":[]`, because the fixture has no note with a lifecycle category, so the per-note state output that slice 05 moves is still never recorded.
- **Exit codes 1 and 7:** fixed (`28-no-vault-json`, `27-lint-strict`). Still open: no case for 5 or 6, and nothing says why they can't be reached. The Check 1 redo asked for one or the other.
- **Trailing newlines invisible:** fixed. Output goes straight to files with `<<END …>>` markers.
- **README next-agent prompt:** fixed in 030ddec and updated again for 02.

## Check these first

1. **Command tables are plain objects, so `constructor` and `toString` become commands** (unsound, low)
2. **The vault-command allowlist and the `VAULT` table are two lists** (unsound, low)
3. **`ctx.vault.index` is documented as a write-back that nothing reads** (unsound, medium)

## needs-you

### `print` stays in `cli.ts`; the flag table moves to `shared.ts`

- **When:** ea9b3ed, `src/commands/shared.ts`, `src/cli.ts`
- **Slice:** 02
- **What happens now:** slice 02's seam lists `print` among what `shared.ts` holds. The worker kept `print` (and `SCHEMA`) in `cli.ts` and hands it to handlers as `ctx.print`, so the envelope stays where CLAUDE.md invariant 6 says `SCHEMA` lives. It also moved something the slice did not list: the whole `parseArgs` options table, now `parseFlags()` and the `Flags` type in `shared.ts`. The router still calls it. The obvious alternatives are to follow the seam literally (put `print` in `shared.ts`), or to leave the options table in `cli.ts` and write a `Flags` type by hand. The gate's grep forbids even a type import of `../cli`, so a derived `Flags` type has to live outside `cli.ts`.
- **The gap:** the README hands "the home of shared helpers" to the worker, while the slice names `print` for `shared.ts`. The two disagree, and the flag table was not mentioned anywhere.
- **Reach:** every later handler gets output through `ctx.print`. Criterion 1 ("cli.ts holds only argument parsing…") is still met in substance, because the parse call and its error mapping stay in the router; only the option list moved.
- **Verdict:** needs-you. The slice said one thing and the worker did another, for a stated reason. **Recommended call:** keep it as built. Output and `SCHEMA` belong to the router, and `Flags` needs a home that isn't `cli.ts`. **To reverse:** move `print` and `SCHEMA` into `shared.ts` and update the docs that name `src/cli.ts` for `SCHEMA`.
- **Confidence:** medium.

## unsound

### Command tables are plain objects, so `constructor` and `toString` become commands

- **When:** ea9b3ed, `src/cli.ts` (`EARLY`, `VAULT`, `const early = EARLY[command]`)
- **Slice:** 02
- **What happens now:** `EARLY` and `VAULT` are object literals, so `EARLY[command]` also finds what every object inherits from its prototype. Unknown names that look like extensions are routed elsewhere, but any call whose first argument is a flag brain doesn't skip (`--limit`, `--rebuild`, …) reaches the table. A probe on both builds:
  - `brain --limit 3 constructor --json`: before, `usage` / unknown command / exit 2. Now `EARLY.constructor` is `Object`, so it "runs" and returns the args array as the exit code. Node then crashes with `ERR_INVALID_ARG_TYPE` and exits 1 with a stack trace on stderr.
  - `toString` crashes the same way. `__proto__` and `hasOwnProperty` give `internal` / exit 1 instead of `usage` / exit 2.
  - With telemetry on, `brain --limit 3 constructor my-private-query` queued `"exit":["my-private-query"]`. That puts user-typed text in a telemetry event, which CLAUDE.md invariant 12 forbids.

  `VAULT` isn't reachable this way today, only because the old allowlist rejects unknown names first. The obvious alternative is a lookup that only sees the table's own entries.
- **The gap:** the slice said "one name→handler table" but not how unknown names behave; the old `if`/`switch` gave that for free.
- **Reach:** slice 06 moves every early command into `EARLY`, and 05 and 07 retire the allowlist that now shields `VAULT`. The pattern gets copied, and its protection goes away. No golden case or test covers it.
- **Verdict:** unsound. The unknown-command path and the telemetry privacy rule both changed. **Redo from:** a command name dispatches only if it is an own entry of the table, so every other name keeps today's `usage` / exit 2 result, and an exit code is always a number before it reaches `main`'s caller or telemetry.
- **Confidence:** low.

### The vault-command allowlist and the `VAULT` table are two lists

- **When:** ea9b3ed, `src/cli.ts`, the `!["index", "search", …, "view", …].includes(command)` check before `VAULT[command]`
- **Slice:** 02
- **What happens now:** a vault command is accepted only if its name is in the old hard-coded list, and only then is `VAULT` consulted. `view` sits in both. If slice 04 or 05 registers a handler in `VAULT` and forgets the list, `brain <name>` reports "unknown command" (exit 2). That is easy to miss when a test happens to cover the name only through another path. The obvious alternative accepts a name if it is in `VAULT` or still handled by the `switch`, so one list shrinks as the other grows.
- **The gap:** the slice asked for "one name→handler table", not what happens to the existing gate.
- **Reach:** slices 03 to 05 each add to `VAULT`; slice 07 is meant to delete the list.
- **Verdict:** unsound. Two sources of truth for which commands exist. **Redo from:** whether a vault command exists is decided by one list (the table plus the commands the `switch` still owns), not by a second list that must be kept in step.
- **Confidence:** low.

### `ctx.vault.index` is documented as a write-back that nothing reads

- **When:** ea9b3ed, `VaultContext.index` in `src/commands/shared.ts`
- **Slice:** 02
- **What happens now:** the doc comment says "a handler that refreshes again stores the new stats here". The router copies its local `index` into `ctx.vault` and never reads it back, and neither moved handler refreshes. Commands in the `switch` that refresh again (log writes, for example) reassign the router's local `let index` and print it themselves. A slice 04 worker who follows the comment and writes `ctx.vault.index = store.refresh()` gets nothing from it, unless the handler prints with that value itself. The obvious alternative is a comment that says the handler owns its refreshed stats, or a router that reads them back if it ever needs them.
- **The gap:** context field names were delegated, but not the semantics of a field the comment promises.
- **Reach:** the log block (slice 04) is the first handler that refreshes twice.
- **Verdict:** unsound. A contract is stated that the code does not keep. **Redo from:** what the context says about `index` matches who reads it. Either the handler prints its own refreshed stats and the field is read-only, or the router reads the field back after the handler returns.
- **Confidence:** medium.

## sound

### `ctx.report` replaces the telemetry context and can only set an error

- **When:** ea9b3ed, `ctx.report` in `run()`
- **Slice:** 02
- **What happens now:** `report({context})` replaces `tContext` outright, and `report({error})` sets `tError` only when the value is truthy. Neither moved handler calls it. The router still sets `tContext` itself in the vault preamble, and `fail()` still sets `tError`, so slice 02's telemetry matches the old code exactly, and the golden and telemetry tests agree. The obvious alternative, merging the context, would only matter once a handler reports one.
- **The gap:** the planning decision fixed that telemetry goes through `ctx.report`, not whether it merges.
- **Reach:** in slice 03, an extension handler that reports `{context}` would wipe the `notes`/`sync` fields the preamble set. Reporting only `{error: "extension_failed"}`, which is what `cli.ts:1181` does today, is safe.
- **Verdict:** sound for this slice.
- **Confidence:** medium.

### Handlers may return a number or a promise of one

- **When:** ea9b3ed, `Handler` in `shared.ts`
- **Slice:** 02
- **What happens now:** the slice decided `(args, flags, ctx) => Promise<number>`. The type also allows a plain `number`, so `path` and `view` are synchronous, and the router `await`s either one inside the same `try` that maps errors through `fail()` and closes the store in `finally`. A synchronous throw and a rejected promise both reach `fail()`.
- **The gap:** none that matters. It is a widening of the decided signature.
- **Reach:** none on behaviour; handlers can be plain functions.
- **Verdict:** sound.
- **Confidence:** medium.

### Moved code keeps its order, its error path and the store's lifetime

- **When:** ea9b3ed, `path.ts`, `view.ts`, the dispatch in `run()`
- **Slice:** 02
- **What happens now:**
  - `path` is dispatched at the same point as before: after the other early commands, before `Store.open`, inside its own `try`/`fail`. It still finds the vault and loads config without creating the index.
  - `view` runs inside the vault `try` after the preamble has opened the store, refreshed, and set `tContext`. Its throws reach the same `fail()`, and `store.close()` still runs in `finally`.
  - The extension-scope checks in `main()` and `run()` run before either table and are unchanged.
  - `CliError` now lives in `shared.ts` and `cli.ts` imports it, so `instanceof` in `fail()` still sees one class.

  The obvious alternative, letting handlers open or close the store, was ruled out by the slice.
- **The gap:** the slice said the router opens and closes the vault context.
- **Reach:** later vault handlers inherit store closing and error mapping for free. `view` reads `ctx.vault!`, which assumes it is only ever registered in `VAULT`.
- **Verdict:** sound.
- **Confidence:** medium.

Trivial naming and delegated fields (`pathCommand`/`viewCommand`, `EARLY`/`VAULT`, `ctx.findVault` and `ctx.print` as context fields, `permit` on the vault context): 1 line, not listed.

## Pattern

Two of the three unsound entries sit in the router's dispatch: how a name becomes a handler, and who decides which names exist. Slices 05, 06 and 07 all build on that lookup, so fix it before 06 widens `EARLY`. Consider adding a golden case for an unknown name reached past a flag (for example `--limit 3 constructor --json`), so the property is gated, not just argued.

## Next step

Before 03, 04 or 06 start, redo the table lookup from the first unsound entry (own entries only, exit code always a number) and make one list decide which vault commands exist. Then rerun this gate.

# Check 3: slices 03 to 07

Scope: the commits after ea9b3ed: 9083e81 (03, ext), adf8ed2 (04, log and export), 138fb64 (05, the other vault commands and the `route()` fix), fc3f4a6 (06, the early commands), 596eacd (07, HELP and the thin router) and 490a7fd (the AGENTS.md doc). Run by `decision-checker` in Check mode with no user present (rule 7): the baseline is this spec (`README.md` plus `slices/03` to `07`), every confidence is capped at medium, and the ledger was saved without asking. The only implementer report is the six commit messages. Calls the slices delegate (file grouping, where the format helpers live, whether `commandPosition` moves, small tidy-ups in `cli.ts`) are judged only where they change behaviour.

Ran at 490a7fd: `npm run compile`, then `golden.sh check` (no diff, exit 0, 42 cases); `npm test`: `# pass 149`, `# fail 0` (`package.test` passed here too); `grep -l '\.\./cli' src/commands/*.ts` (nothing); `git diff --stat ea9b3ed..HEAD -- test/` (empty); `wc -l < src/cli.ts` is 388; the slice 05 and 06 greps print 0. `dist/` matched a fresh compile, so the tree stayed clean. Every moved block was diffed against its original in ea9b3ed's `cli.ts`, ignoring whitespace: the bodies are the same apart from the handler wrapper, `out` becoming `ctx`, `tError = …` becoming `ctx.report({error})`, and `VERSION`/`SCHEMA` coming from the context. A probe ran 40 edge commands against the ea9b3ed build and this one, with telemetry queued locally to a dead local URL: no-vault `context`, extension-scope refusals, usage errors for `agent`, `ext`, `telemetry`, `feedback`, `update` and `setup`, failures in each vault command, `BRAIN_AS` scoping, and the queued telemetry events. Output, exit codes, envelope `command` names and every telemetry event matched, apart from random draft and install IDs and the intended `--limit 3 toString` fix. Probes ran outside the repo and were deleted.

## Check 2 entries: did these commits fix them?

- **Command tables are plain objects:** fixed in 138fb64. `route()` only looks up a table's own entries (`Object.hasOwn`). `brain --limit 3 toString --json` now gives `usage` / exit 2 instead of a crash, and its telemetry event has a numeric `exit`. Golden cases 37 to 41 record prototype names, and 41 is recorded on the pre-split code. Only 41 actually reaches the tables: 37 to 40 take the extension path.
- **Two lists of vault commands:** partly fixed. The hard-coded allowlist is gone, so `VAULT` now decides between vault commands. But `COMMANDS` still gates what reaches either table; see the unsound entry below.
- **`ctx.vault.index` write-back that nothing reads:** fixed. The comment now says a handler keeps its own copy and nothing reads it back, which is what the code does.
- **`print` stays in `cli.ts`** (needs-you) and the three sound entries: unchanged by the code, so still settled. The extension runner, the only `ctx.report` caller, reports only `{error}`, so the "replaces the context" concern never comes up.

## Check these first

1. **`COMMANDS` is still a second list that every new command must join** (unsound, low)
2. **Slice 04's "update the index through the vault context" was not followed** (needs-you, medium)
3. **Doc comments for moved code were left behind in `cli.ts`** (unsound, medium)

## needs-you

### Slice 04's "update the index through the vault context" was not followed

- **When:** adf8ed2, `src/commands/log.ts` (`let index = ctx.vault!.index`), `VaultContext.index` comment in `shared.ts`
- **Slice:** 04, also 05 (`ingest`, `sync`, `lifecycle` do the same)
- **What happens now:** after `brain log add`, the handler refreshes the index again and prints the new counts from its own local copy. `ctx.vault.index` keeps the counts from when the router opened the vault, and the router never reads it back. Slice 04's **Decided** says the handler should update the index "through the vault context, so the router's telemetry still sees the right counts". The worker did not, and the reason holds up: telemetry's `notes` count is `store.count()`, taken in the router before any handler runs, both before and after the split. Writing back through the context would change nothing a user, a test or telemetry can see. The probe showed identical telemetry events for `log add`, `ingest` and `sync`.
- **The gap:** the spec decided a mechanism whose stated reason was not true of the code. The worker picked the faithful move over the literal instruction and did not mark the deviation in the spec.
- **Reach:** a future change that wants post-write counts in telemetry has to add that on purpose. The spec still says the opposite of the code, so a later reader may "fix" it.
- **Verdict:** needs-you. It departs from a spec decision, for a sound reason. **Recommended call:** keep the code. Change slice 04's **Decided** line to "a handler that refreshes keeps its own stats; telemetry counts are taken before the handler runs, as before the split." **To reverse:** have the handlers assign `ctx.vault.index = store.refresh()` and print from it (no visible effect unless the router starts reading it).
- **Confidence:** medium.

## unsound

### `COMMANDS` is still a second list that every new command must join

- **When:** 138fb64 and 596eacd, `src/cli.ts` (`COMMANDS`, `BUILT_INS`, the extension pre-dispatch in `run()`)
- **Slice:** 05, 07
- **What happens now:** the 05 commit says "the VAULT table is the one list". It isn't quite. `run()` first sends any leading name that is not in `BUILT_INS` (built from the hand-written `COMMANDS` array) to the extension runner. So someone who adds `brain stats` to `VAULT` but not to `COMMANDS` gets "unknown command 'stats'" from the extension path, and telemetry records it as `unknown`. Passing a flag first (`brain --limit 3 stats`) skips that path and runs the handler, so whether the command exists depends on where the flags are. Before the split the same trap existed, and it was one of three lists. Now that the tables exist, the obvious alternative builds `COMMANDS` from `Object.keys(EARLY)`, `Object.keys(VAULT)` and `"help"`. That keeps today's behaviour and leaves one place to register a command.
- **The gap:** the Check 2 redo asked for one list to decide which commands exist. The slices removed the allowlist the redo pointed at, but not the older gate in front of it.
- **Reach:** this is the pattern the next command copies. The AGENTS.md note on `src/commands/` doesn't mention `COMMANDS` or `SUBCOMMANDS`, so a new command's telemetry name and dispatch fail quietly.
- **Verdict:** unsound. Two hand-kept lists still decide whether a command exists, and the commit message claims one. **Redo from:** a command exists for dispatch, for the extension pre-dispatch and for telemetry naming because it has a table entry (or is `help`), with nothing else to keep in step, and every current name keeps today's output.
- **Confidence:** low.

### Doc comments for moved code were left behind in `cli.ts`

- **When:** 138fb64 (left behind), 596eacd (the tidy-up that missed them)
- **Slice:** 05, 07
- **What happens now:** `cli.ts` ends with the four-line comment that explains `extractSections` ("A section is its heading line plus everything up to the next heading…"), followed by no code at all. `extractSections` now lives in `src/commands/format.ts` without it. The comment that explained `doctor`'s checks ("Each check names what it found… doctor only reads") now sits above `findVault`, where it reads as describing vault discovery. Seven blank lines remain where the early `if` blocks used to be (`cli.ts:225-231`). A reader of `format.ts` loses the rules for matching sections (prefix, case-insensitive, fenced code ignored), and a reader of `cli.ts` gets a wrong description. The obvious alternative moves each comment with its function.
- **The gap:** a "pure move" said nothing about comments. Tidy-ups in `cli.ts` were delegated to slice 07, which missed these.
- **Reach:** small, but `extractSections` is the one moved function a test imports, and its matching rules are in no other comment.
- **Verdict:** unsound. A move that strands a comment on the wrong code makes the docs wrong. **Redo from:** every comment sits beside the code it describes, and `cli.ts` has no comment for code it no longer holds.
- **Confidence:** medium.

## sound

### Table entries can name what a failure is reported as (`failAs`)

- **When:** 9083e81 (introduced for `ext`), fc3f4a6 (`telemetry`, `feedback`, `agent`)
- **Slice:** 03, 06
- **What happens now:** an `EARLY` entry is a bare handler, whose failures are reported under the command name, or `{ handler, failAs }`. `ext`, `telemetry` and `feedback` fail under their telemetry name (`ext.install`, `telemetry`, `feedback.show`), and `agent` always fails as `agent.install`, exactly as the old `fail(out, tCommand, …)` and `fail(out, "agent.install", …)` calls did. The name matters three ways: it is the `command` in the `--json` error envelope, it goes into the last-error record, and `fail()` skips saving the last error for names starting with `feedback`. `VAULT` entries take no `failAs`, so vault commands still fail as `log`, not `log.add`, as before. The probe matched envelope names for every one of these. The obvious alternative, always failing under the telemetry name, would have changed `setup`, `update`, `path` and every vault command's envelope.
- **The gap:** the spec said only that error mapping stays in the router.
- **Reach:** a new early command with subcommands gets the bare name unless its author adds `failAs`. That is the safe default, but the option is easy to miss.
- **Verdict:** sound.
- **Confidence:** medium.

### The table fix landed inside a refactor slice and restores the pre-split behaviour

- **When:** 138fb64, `route()` in `src/cli.ts`, golden cases 37 to 41
- **Slice:** 05
- **What happens now:** a refactor slice made a behaviour change: `brain --limit 3 toString --json` no longer crashes. Measured against `main` it is no change, because slice 02 caused the crash and the pre-split `if`/`switch` gave `usage` / exit 2. The worker recorded the new golden cases on the pre-split code (fbf78f7), so the gate compares against `main`, not against 02. The obvious alternative, a separate fix commit before 05, would have been easier to review on its own.
- **The gap:** the spec has no slot for fixing a bug that a slice introduced. Check 2 asked for the redo before 03, 04 and 06. It came in 05, after 03 had already copied the table pattern.
- **Reach:** only 41 reaches the tables past a flag, and only for `constructor`. A future table without `route()` would be caught for that name only.
- **Verdict:** sound. It meets the Check 2 redo property, and the baseline is the right one.
- **Confidence:** medium.

### Moved code is verbatim; the context grew `schema` and `version`

- **When:** 9083e81, adf8ed2, 138fb64, fc3f4a6, 596eacd
- **Slice:** 03, 04, 05, 06, 07
- **What happens now:** every moved block matches its original, ignoring whitespace. The few changes are mechanical. Handlers take `ctx` instead of `out`. The extension runner reports `extension_failed` through `ctx.report({error})` instead of setting `tError`. `doctor`, `update`, `feedback` and the runner read `ctx.version` and `ctx.schema` instead of the router's `VERSION` and `SCHEMA`, which remain the only definitions, so `update.test`'s version check still holds. The extension pre-dispatch now builds a full context with `makeCtx`, the same as the table path, and its failure still goes to `fail(out, leading, …)`. The extension-scope checks in `main()` and `run()` are unchanged. The router still opens and closes the store around every vault handler (`finally`). `context` opens and closes its own store, as before. `cli.ts` still re-exports `VERSION`, `telemetryName` and `extractSections`, everything the tests import. The obvious alternative, handlers importing the constants from `cli.ts`, is ruled out by the no-cycle gate.
- **The gap:** none. These follow slice 02's shape.
- **Reach:** `ctx.bin` is now used by no handler (the runner never needed it). Harmless, but it is a context field nothing reads.
- **Verdict:** sound.
- **Confidence:** medium.

### `context` keeps its own catch-all, now inside the router's `try`

- **When:** fc3f4a6, `src/commands/context.ts`, `EARLY.context`
- **Slice:** 06
- **What happens now:** `brain context` still catches every error itself, prints nothing (or an empty `context` envelope with `--json`) and exits 0. The probe matched this outside a vault, with a bad `--limit` and under an extension scope. One thing is new: the handler now runs inside the router's `try`/`fail`. Before, nothing wrapped it, so only a throw from its own `catch` or `finally` (a failing `print` or `close`) could escape, and that crashed the process. Now the same throw becomes an error envelope with exit 1. Both break invariant 11 in that corner, and neither is reachable in normal use. Strict flag parsing and the extension-scope check still run before `context`, as they did before the split.
- **The gap:** slice 06 decided only that `context` keeps its catch-all.
- **Reach:** none in practice.
- **Verdict:** sound.
- **Confidence:** medium.

### The slice 03 check was rewritten from "16/16" to "all its tests (18)"

- **When:** 9083e81, `slices/03-extensions.md` and the README slice graph
- **Slice:** 03
- **What happens now:** the worker edited the spec's own check. `extensions.test.js` has 18 tests, not the 16 the plan guessed, so the check now reads "passes all its tests (18 at the time of the split)". A count-free check could pass if tests were deleted, but the gate's "no test changes" line forbids that. The obvious alternative leaves the spec alone and reports the mismatch.
- **The gap:** the plan's number was wrong, and the spec didn't say who may correct it.
- **Reach:** none on code.
- **Verdict:** sound. It corrects a fact and keeps the check just as strict.
- **Confidence:** medium.

Trivial and delegated (file names, `format.ts` as the helpers' home, export helpers in `log.ts` imported by `sync.ts`, the `setupHandler`/`feedbackHandler` adapters and the `ext` lambda wrapper, `commandPosition` staying in the router, the AGENTS.md note landing a commit late because `CLAUDE.md` is a symlink): 1 line, not listed.

## Pattern

The open items are about how a command gets registered, not about the moved code, which is faithful. Slices 02 to 07 replaced the `if`/`switch` with tables but left `COMMANDS`/`SUBCOMMANDS` as hand-kept lists in front of them, and the spec's slice 04 decision rested on a wrong premise about telemetry. Neither needs another slice. One small follow-up before the PR covers both: derive the lists from the tables, fix the slice 04 text, move the stranded comments.

## Next step

Before the draft PR, derive `COMMANDS` from the tables (behaviour unchanged, the golden check proves it) and move the two stranded comments, then amend slice 04's **Decided** line and rerun the gate.
