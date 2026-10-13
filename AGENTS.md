# brain-cli — agent contract

Headless memory for a markdown vault. `README.md` explains what it is for; this file
holds the rules an agent changing the code must not break.

## Invariants

1. **The vault is the source of truth; the index is a cache.** The index (`$BRAIN_STATE_DIR/<vault>-<id>/index.db`, never inside the vault) can be
   deleted at any time and must rebuild to the same state. Never store anything in the
   index that cannot be re-derived from the markdown — with one exception, the hash of
   what was last exported to each path, whose loss only makes `export` refuse until
   `--force`, never overwrite.
2. **Create, never edit.** The only writes into the vault are new files under the log
   folder (`log add`, `log import`, `lifecycle …`), opened with the `wx` flag so an existing file can
   never be replaced. No command edits, moves or deletes a note. This is what keeps two
   machines conflict-free; an "edit an entry" feature would break it.
3. **`sync` commits only what brain owns**: the log folder and `brain.json`. A conflict
   aborts the rebase and exits 5 naming the files; it never resolves one.
4. **Exports never lose an edit.** A file outside the vault is overwritten only if it is
   byte-identical to what brain last wrote there (or `--force`). Exports are regular files,
   written atomically (tmp + rename).
5. **Fresh on every read.** Every command calls `Store.refresh()` before it answers. No
   watcher, no daemon, no "run index first" requirement.
6. **The `--json` envelope is a contract.** One JSON line on stdout, `schema: "brain.v1"`,
   `ok`, and either `data` or `error.code`. Changing its shape means bumping `SCHEMA` in
   `src/cli.ts` and saying so in the README. Exit codes are part of it.
7. **User input never reaches FTS5 unquoted** unless `--raw` was passed. `toMatchExpression`
   quotes every term.
8. **Zero runtime dependencies.** `node:sqlite`, `node:util` `parseArgs` and a small
   frontmatter parser in `src/note.ts`. A dependency has to justify itself against
   `npx brain-cli` staying instant and native-build-free.
9. **Scopes hide, they do not reveal.** Under `BRAIN_AS`, an out-of-scope note is
   `not_found` (never "forbidden"), filtered inside the query so `limit` still counts. A
   scope is a guardrail for brain's output, not a sandbox; docs must never claim more.
10. **No sync service is assumed.** Nothing outside `src/sync.ts`'s git mode may require
   git; every other guarantee must hold when iCloud or Dropbox moves the files.
11. **`brain context` never fails.** It runs inside other tools' startup hooks: on any
   error it prints nothing and exits 0. The installer never edits a harness's settings
   file; it prints the snippet.
12. **Notes never leave the machine** except through the user's own `brain sync` to the
   vault's remote. Two other things may: anonymous telemetry — off unless a person said yes
   to the one-time terminal question or opted in explicitly; never asked of agents, scripts,
   CI or hooks — whose fields are
   exactly `Event` in `src/telemetry.ts` and docs/telemetry.md — adding a field means updating
   both and the test that searches events for private strings; and feedback, only as a
   redacted draft a person submits, or posted with their permission. Never in the foreground
   of a command, never on stdout, never able to fail a command.

## Layout

- `src/note.ts` — parse one note: frontmatter, title, headings, tags, aliases, wiki-links.
- `src/store.ts` — the SQLite index: schema, incremental refresh, search, resolve, get.
- `src/config.ts` — `brain.json` (synced) and the machine-local user config: sync mode,
  integrations, `BRAIN_AS`, read scope.
- `src/log.ts` — log entries: add, list, import, render a view, export with drift check.
- `src/sync.ts` — sync modes: git (commit the log, pull --rebase, push), none, command.
- `src/lifecycle.ts` — categories, review windows, lifecycle events (`log/lifecycle/`) and
  each note's state (frontmatter, then events, latest wins).
- `src/lint.ts` — read-only vault health rules.
- `src/agent.ts` — `brain context` (the session primer) and `brain agent install` per harness.
- `src/cli.ts` — argument parsing, vault discovery, output and exit codes.
- `skills/brain/SKILL.md` — the skill every harness installs; its `description` decides
  when an agent reaches for brain, so change it deliberately.
- `agents/pi/brain-memory.ts` — the Pi extension (not compiled here; Pi loads it).
- `scripts/verify-pi.sh` — real Pi, fake model: the skill is listed, one primer per session.
- `bin/brain.js` — the executable; imports the compiled `dist/src/cli.js`.
- `test/` — `node:test`. `cli.test.ts` and `sync.test.ts` run the real binary;
  `sync.test.ts` simulates two machines sharing one bare remote.

## Checks

`npm test` builds and runs everything. Run it before every commit.
