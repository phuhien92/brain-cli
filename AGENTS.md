# brain-cli — agent contract

Headless memory for a markdown vault. `README.md` explains what it is for; this file
holds the rules an agent changing the code must not break.

## Invariants

1. **The vault is the source of truth; the index is a cache.** `.brain/index.db` can be
   deleted at any time and must rebuild to the same state. Never store anything in the
   index that cannot be re-derived from the markdown.
2. **Read-only over the vault** in this version. No command writes, moves or rewrites a
   note. (Writing arrives with `brain log add` in step 2, and it will only ever create new
   files.)
3. **Fresh on every read.** Every command calls `Store.refresh()` before it answers. No
   watcher, no daemon, no "run index first" requirement.
4. **The `--json` envelope is a contract.** One JSON line on stdout, `schema: "brain.v1"`,
   `ok`, and either `data` or `error.code`. Changing its shape means bumping `SCHEMA` in
   `src/cli.ts` and saying so in the README. Exit codes are part of it.
5. **User input never reaches FTS5 unquoted** unless `--raw` was passed. `toMatchExpression`
   quotes every term.
6. **Zero runtime dependencies.** `node:sqlite`, `node:util` `parseArgs` and a small
   frontmatter parser in `src/note.ts`. A dependency has to justify itself against
   `npx brain-cli` staying instant and native-build-free.
7. **Nothing leaves the machine.** No network calls, no telemetry, no embeddings API.

## Layout

- `src/note.ts` — parse one note: frontmatter, title, headings, tags, aliases, wiki-links.
- `src/store.ts` — the SQLite index: schema, incremental refresh, search, resolve, get.
- `src/cli.ts` — argument parsing, vault discovery, output and exit codes.
- `bin/brain.js` — the executable; imports the compiled `dist/src/cli.js`.
- `test/` — `node:test`. `cli.test.ts` runs the real binary.

## Checks

`npm test` builds and runs everything. Run it before every commit.
