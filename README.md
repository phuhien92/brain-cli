# brain-cli

Headless memory for a markdown vault, built for AI agents.

`brain` indexes a folder of markdown notes — an Obsidian vault, a docs folder, an
agent's learnings — and gives any agent ranked search over it from the shell, with a
stable JSON contract. No app has to be running, no API key, nothing leaves the machine.

```console
$ brain search "deploy gotchas on the mac mini" --limit 3
1. firstmate/learnings/2026-10-13-pnpm-cache.md  (6.212)
   pnpm cache breaks after an OS update — …the [mac] [mini] keeps a stale store; [deploy] fails until…
2. Projects/blog/runbook.md  (4.087)
   Blog runbook — …## [Deploy] - Vercel builds from main. Known [gotchas]: preview env vars…
3. MEMORY.md  (2.951)
   …two machines: the [mac] [mini] runs the long jobs, the laptop travels…
```

## Why

Agents can already `grep` a vault, and for an exact string they should. But grep
returns *every* file that mentions a word, unranked. On a 127-note vault, "interview"
matches 61 files, and the agent pays tokens to open them to find out which ones matter.

`brain search` returns the handful that are *about* the question, ranked by BM25 with
titles, aliases and headings weighted above passing mentions, plus a snippet of where
each one matched. The agent reads three notes instead of sixty.

Obsidian has excellent search, and since 1.12 an official CLI — but it requires the
desktop app to be running. That rules it out exactly where agent memory is needed: cloud
sessions, cron jobs, and agents working on another machine over SSH. `brain` reads the
same markdown, wiki-links and frontmatter, headlessly. It does not replace Obsidian; it
is the layer agents use while Obsidian is closed.

## Install

Requires Node.js **22.13+** (it uses the built-in `node:sqlite`, so there are no native
dependencies to compile).

```sh
npm install -g github:phuhien92/brain-cli
# or, from a clone
npm install && npm run build && npm link
```

## Use

```sh
brain index                      # bring the index up to date (every command does this anyway)
brain search "renewal deadline" # ranked search
brain search pnpm --path firstmate --tag ops --limit 5
brain search 'lease AND renewal' --raw   # SQLite FTS5 syntax: AND, NEAR, prefix*
brain get "Projects/blog/runbook" # print a note by path, file name, title or alias
brain get "Blog runbook" --meta  # frontmatter, tags, headings and links only
```

The vault is `--vault <dir>`, else `$BRAIN_VAULT`, else the nearest parent folder holding
`.obsidian/` or `.brain/`.

### Teaching an agent to use it

Add this to your `AGENTS.md` / `CLAUDE.md` (any harness that can run a shell command can
use `brain`; there is no MCP server to configure):

```markdown
## Notes and memory
- For questions about my notes, run `brain search "<question>" --json` first and read the
  top results with `brain get <path> --json`. Rephrase and search again before concluding
  something is not in the vault.
- Use grep only for exact strings (a file name, an ID, a quoted phrase).
```

## The JSON contract

Every command takes `--json` and writes exactly one line to stdout:

```json
{
  "schema": "brain.v1",
  "command": "search",
  "ok": true,
  "vault": "/Users/me/vault",
  "index": { "added": 0, "updated": 1, "removed": 0, "unchanged": 126, "ms": 9 },
  "data": {
    "query": "pnpm cache",
    "results": [
      { "path": "firstmate/learnings/2026-10-13-pnpm-cache.md",
        "title": "pnpm cache breaks after an OS update",
        "score": 6.212, "snippet": "…the [pnpm] [cache] keeps a stale store…", "tags": ["ops"] }
    ]
  }
}
```

Failures keep the same shape with `"ok": false` and an `error` object, and a distinct exit
code, so an agent can branch without parsing prose:

| Exit | `error.code` | Meaning |
| --- | --- | --- |
| 0 | — | ok (an empty result list is still ok) |
| 1 | `no_vault`, `internal` | no vault found, or an unexpected failure |
| 2 | `usage`, `bad_query` | bad arguments, or invalid `--raw` FTS5 syntax |
| 3 | `not_found` | `get` matched no note |
| 4 | `ambiguous` | `get` matched several notes; `error.candidates` lists their paths |

`schema` changes only on a breaking change to this shape.

## How the index stays fresh

The design is borrowed from [Serena](https://github.com/oraios/serena): index once up
front, then keep the index current as a side effect of using it.

- The index is a SQLite file at `<vault>/.brain/index.db` — a cache, never committed
  (add `.brain/` to the vault's `.gitignore`). Delete it and it rebuilds.
- Every command starts with a refresh: it `stat`s each note and compares modification
  time and size with the index. Only changed files are read; of those, only files whose
  **content hash** changed are re-parsed, so a `git checkout` that touches timestamps
  costs nothing. Deleted notes are dropped.
- There is no file watcher and no daemon. The index cannot be stale at the moment it is
  read, and keeping it that way costs one `stat` per note: ~10 ms on a 127-note vault,
  against ~130 ms for the first full build.

Each note is parsed for its title (frontmatter `title`, else the first `# H1`, else the
file name), aliases, headings, tags (frontmatter and inline `#tags`, ignoring code), and
wiki-links (`[[target#heading|alias]]`, embeds included). Search is SQLite FTS5 with
Porter stemming, so "designing" finds "design".

### Why no vector database (yet)

The caller is an LLM. When a keyword search comes back thin, it rephrases — "why did
the build break" becomes "pnpm cache" — at almost no cost, which covers most of what
embeddings would. Keyword search is also deterministic, explainable (the snippet shows
why a note matched), needs no model download or API key, and never sends a note to a
third party. If the benchmark below shows paraphrased questions failing, semantic search
will arrive as an optional mode stored in the same SQLite file, not a separate service.

## Roadmap

This is step 1 of four.

1. **Core** — `index`, `search`, `get`, incremental indexing, `--json`. ✅
2. **Memory that syncs across machines** — `brain log add` writes one file per entry so
   two machines never edit the same file and git never conflicts; a generated
   `learnings.md` view; `brain sync`. First consumer:
   [firstmate](https://github.com/kunchenguid/firstmate), whose memory is currently local
   to one machine.
3. **Scopes** — `brain search --scope engineering`, so a coding agent can read the
   engineering notes without being able to read the finance ones.
4. **Lifecycle and lint** — review windows by category (`current-state`, `news`,
   `research`), archive, broken-link and orphan checks; and a published benchmark of grep
   vs. the Obsidian CLI vs. `brain` on real questions, measuring tokens read and whether
   the right note came back.

## Develop

```sh
npm install
npm test        # builds, then runs node:test over the parser, the index and the real binary
```

## License

MIT
