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
