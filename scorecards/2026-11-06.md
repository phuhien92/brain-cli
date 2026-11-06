# Codebase scorecard: brain-cli

<!-- meta:start -->
| Key | Value |
|---|---|
| Repo | phuhien92/brain-cli |
| Commit | 7045e68 |
| Date | 2026-11-06 |
| Rubric approved | yes |
| Scorers independent | yes |
<!-- meta:end -->

## Size

<!-- size:start -->
| File | Lines | Tier |
|---|---|---|
| `src/cli.ts` | 1692 | over hard (1000) |
| `test/extensions.test.ts` | 997 | over soft (800) |
| `src/extensions.ts` | 540 | over target (500) |

Skipped: lockfile: 1, symlink or not a file: 1, not a code file: 57, vendored or build folder: 17
<!-- size:end -->

## Scores

<!-- scores:start -->
| Area | Score | Scope | Sample | Evidence |
|---|---|---|---|---|
| Architecture | 4 | `src/` (shipped CLI) | 16 of 17 | `src/config.ts:27` is the only import back from a lower module; dependencies run cli → features → store/config → note/paths, as `AGENTS.md:60-76` documents |
| Modularity | 3 | `src/` (shipped CLI) | 16 of 17 | `src/cli.ts:287-983`: one `run()` routes and implements every command; `cli.ts` imports 23 modules and is over the hard tier |
| Abstraction | 3 | `src/` (shipped CLI) | 6 of 11 | `src/store.ts:71` exposes `db`, and callers write raw SQL against it (`src/lint.ts:37`, `src/lifecycle.ts:69`, `src/cli.ts:1381`) |
| Components | 3 | `src/` and `test/` | 5 of 9 | `src/lifecycle.ts:43-47` reads `BRAIN_TODAY` from the environment deep inside; `test/lint.test.ts:14-20` runs the whole CLI to test `lint` |
| Errors | 4 | CLI runtime in `src/` | 6 of 8 | `src/cli.ts:1593`: one `fail()` maps every typed error to a code, a specific exit, a JSON envelope, and a saved last-error record |
<!-- scores:end -->

## Error trace

A broken `brain.json` in the vault, then `brain search x`. Read only; no test run (`node_modules` isn't installed).

<!-- trace:start -->
1. `src/config.ts:341`: raised as a `ConfigError` with what (invalid JSON), where (the file path), and why (the parser's message). The original error object is dropped.
2. `src/config.ts:69`: passes up unchanged from `loadConfig`.
3. `src/cli.ts:547`: passes through the command's try block to the catch.
4. `src/cli.ts:1602`: becomes code `config`, exit 1, same message.
5. `src/cli.ts:1608`: the last-error record is saved (command, args, code), which is the handle.
6. `src/cli.ts:1627`: the person sees `brain: <path>: invalid JSON (<reason>)`. All four are present, but exit 1 is shared with internal errors.
<!-- trace:end -->

## Per area

- **Architecture (4).** Sample: agent, cli, config, extensions, feedback, hooks, lifecycle, lint, log, note, paths, setup, source, store, sync, telemetry, update. Counter-example: `src/cli.ts:1381` runs raw SQL around the Store API, and `src/cli.ts:1190-1209` runs extension processes in the CLI layer. Next step up: make `cli.ts` match its documented job; move the extension runner into `extensions.ts` and add a Store method for the note list.
- **Modularity (3).** Sample: the same 17 `src/` modules; 16 are focused. Counter-example: `src/note.ts:1`, 187 lines, no imports, one concern. Next step up: move each command's handler out of `cli.ts` into its module or a `commands/` folder, leaving a thin router. History is one squashed commit, so the folder layout is the evidence.
- **Abstraction (3).** Sample: agent, hooks, source, sync, note, paths (fit); lifecycle, lint, log, cli, extensions (leak or duplicate). Also, slug has two homes: `src/config.ts:320` and `src/extensions.ts:89`. Counter-example: `src/agent.ts:28`, where `context()` uses `listEntries` and `inReadScope` with no knowledge of storage. Next step up: make `db` private behind Store query methods and keep one `slug`; a 4 needs 8 of 11.
- **Components (3).** Sample: `note.parseNote`, `store.toMatchExpression`, `Store.open`, `agent.install`, `setup.findVaultCandidates` (fit); `lint.lint`, `lifecycle.lifecycleStates`, `telemetry.status`, `update.disabledReason` (don't). Counter-example: `test/note.test.ts:6-34` calls the parser directly with a string. Next step up: pass the date, environment flags, and state root in as parameters, then test `lint` and `lifecycleStates` directly.
- **Errors (4).** Sample: invalid `brain.json` (`src/config.ts:341`), no note matches (`src/cli.ts:613`), ambiguous ref (`src/cli.ts:615`), ingest missing file (`src/cli.ts:566`), search error rethrown as internal (`src/cli.ts:595`), git push failed (`src/sync.ts:149`), extension couldn't start (`src/cli.ts:1212`), gh post failed (`src/cli.ts:1355`); the search rethrow and git push miss. Counter-example: `src/cli.ts:1605`, where unknown errors become "internal", exit 1, stack dropped. Next step up: attach `{ cause }` on every rewrap, keep a stack or ID on internal errors, and give config errors their own exit code.

## Change since last scorecard

<!-- delta:start -->
First run.
<!-- delta:end -->
