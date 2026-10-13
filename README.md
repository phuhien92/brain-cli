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
brain get "Blog runbook" --section Deploy   # just that section — for long notes
brain log add learning "..."     # record memory (see below)
brain sync                       # share it with your other machines
```

The vault is `--vault <dir>`, else `$BRAIN_VAULT`, else the nearest parent folder holding
`.obsidian/` or a `brain.json`.

### Teaching an agent to use it

An agent has to know brain exists before it can call it. `brain agent install` sets that
up per harness, in two layers:

- **A skill** (`skills/brain/SKILL.md`, the [Agent Skills](https://agentskills.io) format).
  Only its one-paragraph description sits in the agent's context; the full instructions
  load when a question matches — "what did I decide about…", "do I have notes on…". It
  costs almost nothing until it is needed.
- **A primer at session start** from `brain context`: what brain is, plus the five most
  recent memory titles, so the agent starts each session knowing what it knows.

| Harness | `brain agent install …` | Skill | Session primer |
| --- | --- | --- | --- |
| Claude Code | `claude` | `~/.claude/skills/brain/` | a `SessionStart` hook running `brain context` — printed for you to paste into `~/.claude/settings.json`; brain never edits your settings |
| [Pi](https://pi.dev) | `pi` | `~/.agents/skills/brain/` (Pi reads it; not also `~/.pi/agent/skills`, which would collide) | `~/.pi/agent/extensions/brain-memory.ts`, injecting once per session — Pi persists injected messages, so once is the only safe cadence |
| Others | `agents` | `~/.agents/skills/brain/`, for harnesses that read the Agent Skills shared location | add `brain context` to the harness's own startup hook |

`brain context` prints nothing and exits 0 when there is no vault, so a hook can never
break the agent that runs it. The installer refuses to replace a file it did not write
(`--force` to override) and `--dry-run` shows what it would do.

The Pi integration is checked end to end in CI: [`scripts/verify-pi.sh`](scripts/verify-pi.sh)
runs a real Pi against a fake local model and asserts that the request lists the skill and
carries exactly one primer on the first turn and on the second.

For a harness without skills or hooks, one line in its always-loaded instructions works:

```markdown
For questions about my notes or past decisions, run `brain search "<question>" --json` first;
use grep only for exact strings.
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
| 5 | `sync_conflict`, `export_drift` | a note was edited on two machines (`error.files`), or an exported file was edited since brain wrote it |
| 6 | `not_permitted` | the acting integration (`BRAIN_AS`) may not write that kind |

`schema` changes only on a breaking change to this shape.

## One vault, many repos

Several tools can share one vault — an agent orchestrator, a coaching skill, scheduled
jobs — and more will come. Each is an **integration**, declared in the vault's
`brain.json` with the folders it may read and the memory kinds it may write; its paths on
each machine live in that machine's config; its agents run with `BRAIN_AS=<name>`.

```json
{ "integrations": {
    "interview-coach": { "read": ["Career HQ/"], "write": ["interview"] },
    "firstmate": { "read": ["firstmate/"], "write": ["learning"] } } }
```

A scoped agent's searches, reads and log only see its folders; anything else is "not
found". Adding a repo is configuration, never code: [docs/integrations.md](docs/integrations.md).
`brain integrations` lists who is connected; `brain doctor` checks this machine's setup.

## Memory across machines

An agent's memory is usually one file — `learnings.md`, `MEMORY.md` — that every session
appends to. Put that file in git and use it from two machines, and the first sync is a
merge conflict: both machines appended to the same place.

`brain` stores memory as a **log of one file per entry** instead:

```sh
brain log add learning "pnpm cache breaks after macOS updates" --body "Run pnpm store prune." --tag ops
# → log/learning/2026-10-13-mac-mini-pnpm-cache-breaks-after-macos-updates.md
brain log 5                      # recent entries, any kind
brain view learning              # every learning, oldest first, as one markdown list
brain sync                       # commit new entries, pull --rebase, push, re-export
```

Two machines never create the same file, so `git` merges their logs with no conflict, ever.
The single-file shape that existing tools expect is *generated* from the log, so it is
never edited by two machines either. Each entry records which machine wrote it.

- **`brain sync`** follows the vault's `"sync"` mode, because files reach other machines
  in many ways: `git` (any remote) commits only the log folder and `brain.json` — never a
  note you are halfway through — then pulls with rebase and pushes, stopping with exit 5
  and the file names if a *note* was edited on both machines; `none` leaves moving files
  to iCloud, Dropbox, Syncthing or Obsidian Sync; `{ "command": … }` runs yours. `auto`
  (the default) picks git when the vault is a git repository.
- **`brain export`** writes a view to a path outside the vault as a regular file (not a
  symlink — some tools rightly refuse those). If that file was edited since brain last
  wrote it, it refuses, because those edits are not in any entry yet. Capture them with
  `brain log import`, then `brain export --force`.
- **`brain log import <kind> <file>`** turns an existing memory file into entries, one per
  top-level list item, dropping HTML-comment markers from titles. Titles already recorded
  are skipped, so importing on a second machine adds only what is new there.

Configuration is split by what may travel:

```jsonc
// <vault>/brain.json — committed, the same on every machine (optional)
{ "log": { "dir": "log" } }

// ~/.config/brain/config.json — this machine only ($BRAIN_CONFIG overrides the path)
{
  "machine": "mac-mini",
  "exports": [
    { "kind": "learning", "path": "~/firstmate/data/learnings.md",
      "header": "<!-- memory tiers: see the stow skill -->" }
  ]
}
```

[docs/firstmate.md](docs/firstmate.md) walks through moving
[firstmate](https://github.com/kunchenguid/firstmate)'s fleet learnings onto two machines.

## How the index stays fresh

The design is borrowed from [Serena](https://github.com/oraios/serena): index once up
front, then keep the index current as a side effect of using it.

- The index is a SQLite file **outside the vault**, at
  `~/.local/state/brain/<vault-name>-<id>/index.db` (`$BRAIN_STATE_DIR` to move it). Vaults
  get synced — by git, and just as often by iCloud, Dropbox or Obsidian Sync — and a live
  SQLite database synced between two machines corrupts or forks into "index 2.db". So the
  vault holds only markdown, and each machine builds its own index. Delete it and it
  rebuilds.
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

1. **Core** — `index`, `search`, `get`, incremental indexing, `--json`. ✅
2. **Memory that syncs across machines** — one file per entry, generated views, `export`
   with drift protection, `import`, `sync`. First consumer:
   [firstmate](https://github.com/kunchenguid/firstmate). ✅
3. **Integrations and scopes** — named integrations with read folders and write kinds,
   `BRAIN_AS`, pluggable sync, `brain doctor`. ✅
4. **Lifecycle and lint** — review windows by category (`current-state`, `news`,
   `research`), archive, broken-link and orphan checks; and a published benchmark of grep
   vs. the Obsidian CLI vs. `brain` on real questions, measuring tokens read and whether
   the right note came back.
5. **Extensions** — anyone can add a command (`brain <name>`) or a hook on brain's
   events in any language, as a separate process speaking the `--json` contract, with a
   manifest that declares what it reads, writes and contacts. Importers, embeddings and
   new views belong here, not in the core.
6. **`brain ui`** — a local web page (127.0.0.1 only) for status, integrations, this
   machine's config, extensions and a search playground, like Serena's dashboard.

Steps 5 and 6 are designed, not built: [docs/design/extensions.md](docs/design/extensions.md).

## Develop

```sh
npm install
npm test        # builds, then runs node:test over the parser, the index and the real binary
```

## License

MIT
