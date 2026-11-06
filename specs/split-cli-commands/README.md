# Split the command handlers out of cli.ts

**Branch:** `claude/split-cli-commands`

## Intent

> Split the command handlers out of `src/cli.ts` (1,692 lines, over the hard size tier) so `cli.ts` becomes a thin router for argument parsing, vault discovery, output and exit codes, as its own CLAUDE.md layout already describes. Pure refactor: no behaviour change.

How the user will know it worked (accepted):

1. `src/cli.ts` ends under 500 lines and holds only argument parsing, finding the vault, output and exit codes.
2. All 149 tests pass without changing what they check.
3. No change for users of `brain`: same output, same `--json` envelope, same exit codes.
4. The after-`codebase-rubric` score is informational, not required.

This is the first real end-to-end run of the factory loop: `codebase-rubric` before (Modularity 3, `scorecards/2026-11-06.md`), this spec, the build with the `decision-checker` gate, then `codebase-rubric` after.

## Non-goals

- Any change a test or the `--json` output would notice. No `SCHEMA` bump.
- Changes to the logic modules (`src/log.ts`, `src/store.ts`, `src/lifecycle.ts`, and the rest).
- Fixing what the scorecard found (raw SQL around `Store`, the extension runner's home, environment reads, error causes). Tracked in [#26](https://github.com/phuhien92/brain-cli/issues/26).
- A version bump or release: nothing changes for users.
- New dependencies.

## Constraints

- `npm test` passes after every slice; each slice is its own commit.
- `dist/src/` is committed: stage the new `dist/src/commands/*.js` with each slice, or `test/package.test.ts` fails.
- No test file changes at all. `cli.ts` keeps re-exporting what tests import (`extractSections`, `VERSION`, `telemetryName`, and anything else a test imports from it).
- Backward compatibility: the CLI's behaviour is the compatibility surface; internal module paths are free to change.

## Slice graph

| # | Slice | Question it answers | Check | Depends on |
|---|---|---|---|---|
| 01 | golden-capture | Can we prove output is byte-identical beyond what tests assert? | `golden.sh capture` twice: identical | none |
| 02 | handler-shape | Does one handler shape serve a no-vault and a vault command? | Gate + `path`, `view` gone from cli.ts | 01 |
| 03 | extensions | Does the riskiest code (spawn, timeouts, binary path, telemetry error) survive the move? | Gate + `extensions.test.js` 16/16 | 02 |
| 04 | log-export | Does the largest block move whole? | Gate + `log.test.js` passes | 02 |
| 05 | vault-commands | Do the remaining vault commands fit the shape? | Gate + vault `switch` gone | 04 |
| 06 | early-commands | Can the no-vault branch become table lookups? | Gate + early `if (command ===` gone | 02 |
| 07 | thin-router | Is cli.ts only the router, under 500 lines? | Gate + `wc -l` below 500 | 03, 05, 06 |

Build order comes from **Depends on**. 03, 04, and 06 can run in parallel after 02; they touch different parts of `cli.ts`, so serialize them if merges get noisy.

**Gate (every slice):** `npm test` prints `# pass 149` and `# fail 0`; `grep -l '\.\./cli' src/commands/*.ts` prints nothing (no import cycle); `specs/split-cli-commands/golden.sh check` prints no diff; `git diff --stat main -- test/` is empty.

## Open questions

- None blocking. If 07 can't reach 500 after moving HELP, the worker stops and reports the remaining line budget rather than moving code that belongs in the router.

## Decided in planning

- **`src/commands/`, one file per command or group, one handler shape, one name→handler table in `cli.ts`** (user). Logic modules stay free of printing and exit codes.
- **Pure move; fixes go to #26** (user). Keeps the diff reviewable and the after-score attributable to the split.
- **The worker decides** file grouping and names, context fields, the home of shared helpers, and slice order after 02 (user). Anything a test or `--json` would notice comes back to the user.
- **Handlers throw; only the router calls `fail()`**, so error mapping and exit codes stay in `cli.ts` (seams drafter). The fail-fast drafter put `fail` in `shared.ts`; turned down because exit codes are the router's job by `CLAUDE.md`.
- **Telemetry state (`tCommand`, `tContext`, `tError`) is set through the context** (`ctx.report({context, error})`), never through a module global a handler imports (all three drafters). It is written from three places today (`cli.ts:554`, `:1248`, `:1606`), and a miss fails silently.
- **Moved code takes the binary path from the context**: `BIN` is computed from `import.meta.url` with `../..` (`cli.ts:232`) and would break one folder deeper (fail-fast drafter).
- **HELP moves to `src/commands/help.ts`** (all three drafters): HELP is ~130 lines (`cli.ts:56-186`), and without moving it `cli.ts` lands around 510-550.
- **A golden output check (01)** in addition to the tests (fail-fast and seams drafters): the tests don't assert every `--json` field.
- **Extensions move early (03)** as the riskiest code (fail-fast and seams drafters). The lean drafter moved them last; turned down so the pattern is proven on the hard case before most code depends on it.
- **No test file changes at all**, re-exports instead. The brief said "imports may move"; the seams drafter caught that this contradicts "stop rather than edit a test".
- Drafts were independent: three subagents with lean, fail-fast, and seams lenses.

## Next agent prompt

Status: planned, nothing built. Start with 01. Baseline: 149 tests pass at `fbf78f7`.

Before reporting a slice done, follow the `decision-checker` skill in Check mode on this branch and save `decisions.md` here. Update this prompt before you end.
