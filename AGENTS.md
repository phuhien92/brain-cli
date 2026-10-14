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
   folder (`log add`, `log import`, `log retire`, `log replace`, `lifecycle …`) and immutable originals plus metadata
   sidecars under `sources/` (`ingest`), opened with the `wx` flag so an existing file can
   never be replaced. No command edits, moves or deletes a note or source. The writable set
   includes `sources/` so provenance can travel with the vault without weakening the
   create-only rule that keeps two machines conflict-free.
3. **`sync` commits only what brain owns**: the log folder, ingested source pairs in `sources/` and
   `brain.json`. A conflict
   aborts the rebase and exits 5 naming the files; it never resolves one.
4. **Exports never lose an edit.** A file outside the vault is overwritten only if it is
   byte-identical to what brain last wrote there (or `--force`). Exports are regular files,
   written atomically (tmp + rename).
5. **Fresh on every read.** Every command that reads notes calls `Store.refresh()` before it answers. No
   watcher, no daemon, no "run index first" requirement.
6. **The `--json` envelope is a contract.** One JSON line on stdout, `schema: "brain.v1"`,
   `ok`, and either `data` or `error.code`. Changing its shape means bumping `SCHEMA` in
   `src/cli.ts` and saying so in the README. Exit codes are part of it.
7. **User input never reaches FTS5 unquoted** unless `--raw` was passed. `toMatchExpression`
   quotes every term.
8. **Zero runtime dependencies.** `node:sqlite`, `node:util` `parseArgs` and a small
   frontmatter parser in `src/note.ts`. A dependency has to justify itself against
   installing from GitHub staying instant and native-build-free. (Never write `npx brain-cli`:
   that npm name belongs to an unrelated project.)
9. **Scopes hide, they do not reveal.** Under `BRAIN_AS`, an out-of-scope note is
   `not_found` (never "forbidden"), filtered inside the query so `limit` still counts. A
   scope is a guardrail for brain's output, not a sandbox; docs must never claim more.
10. **No sync service is assumed.** Nothing outside `src/sync.ts`'s git mode may require
   git; every other guarantee must hold when iCloud or Dropbox moves the files.
11. **`brain context` never fails.** It runs inside other tools' startup hooks: on any
   error it prints nothing and exits 0. The installer never edits a harness's settings
   file; it prints the snippet.
12. **brain core never sends notes off the machine** except through the user's own `brain sync`
   to the vault's remote. An installed extension is separately approved local code with the
   user's OS permissions; its declared network hosts are disclosure, not enforcement. Two
   other core features may send data: anonymous telemetry — off unless a person said yes
   to the one-time terminal question or opted in explicitly; never asked of agents, scripts,
   CI or hooks — whose fields are
   exactly `Event` in `src/telemetry.ts` and docs/telemetry.md — adding a field means updating
   both and the test that searches events for private strings; and feedback, only as a
   redacted draft a person submits, or posted with their permission. One more core feature
   contacts the network and sends nothing: the update check, once a day, asking GitHub for
   the repository's version tags (on by default; off with `BRAIN_NO_UPDATE_CHECK=1` or
   `"updates": { "check": false }`). None of these ever runs in the foreground of a command,
   writes to stdout, or can fail a command; only `brain update --check`, which a person asked
   for, waits on its request.

## Layout

- `src/note.ts` — parse one note: frontmatter, title, headings, tags, aliases, wiki-links.
- `src/store.ts` — the SQLite index: schema, incremental refresh, search, resolve, get.
- `src/paths.ts` — where brain keeps things (state, index, configs, log, sources). The one resolver
  behind `brain path`, `doctor`, the index and telemetry; it never creates anything.
- `src/config.ts` — `brain.json` (synced) and the machine-local user config: sync mode,
  integrations, `BRAIN_AS`, read scope.
- `src/log.ts` — log entries: add, list, import, retire, render a view, export with drift check.
- `src/sync.ts` — sync modes: git (commit the log, pull --rebase, push), none, command.
- `src/lifecycle.ts` — categories, review windows, lifecycle events (`log/lifecycle/`) and
  each note's state (frontmatter, then events, latest wins).
- `src/lint.ts` — read-only vault health rules.
- `src/update.ts` — the daily background update check, the once-a-day stderr notice for a
  person at a terminal, and `brain update`. Never shown with `--json`, `--quiet`, in CI or hooks.
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

`npm test` builds and runs everything. Run it before every commit. `dist/src/` is committed
(installs from GitHub need no compiler): stage it with your change, because
`test/package.test.ts` compares what is staged with a fresh compile.

## Design and brand assets

A logo, banner or other visual change is judged by how it renders, not by whether a test
passes. Before a PR that touches `assets/` (or any visual) is ready for review:

1. **Render it and look.** The logo at 128, 64, 32 and 16 px, on a light and a dark
   background; the banner at full width. 16 px is the favicon and tab size and where
   outlines, halos and fine strokes turn to mud.
2. **Compare it with what it replaces**, side by side in the same image.
3. **Put that image in the PR description.** A reviewer approves the picture, not the
   SVG source.
4. **Check contrast on rendered pixels**, where the text or mark actually sits, never
   only against a gradient's endpoints. A fix that passes a number by flattening the
   gradient or outlining the mark is a regression if it looks worse at 16 px.

Use only colors from the design tokens, and prefer removing an element to adding a stroke
around it. Any headless browser can render the comparison, e.g.
`chromium --headless --screenshot=compare.png --window-size=1280,1000 compare.html`.

## Releases

Every merge to `main` that changes behaviour is a release: bump `version` in `package.json`
and `VERSION` in `src/cli.ts` (minor for a feature, patch for a fix), add a `CHANGELOG.md`
entry, and tag the merge `v<version>`. The update check announces the highest tag, so an
untagged commit is never announced. `test/update.test.ts` fails if the two versions differ
or the changelog has no entry for the current one.
