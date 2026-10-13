# Command reference

`brain help` prints the same list with every flag. All commands take `--json`, `--quiet`,
`--vault <dir>` and `--as <integration>`.

| Command | What it does | More |
| --- | --- | --- |
| `setup [--yes …]` | first-run walkthrough: vault, machine, sync, agents, telemetry, shell profile | [setup](#setup) |
| `index [--rebuild\|--verify]` | bring the index up to date (every command does this first) | [indexing.md](indexing.md) |
| `search <query>` | ranked full-text search; `--limit`, `--path`, `--tag`, `--raw`, `--include-archived` | below |
| `get <note>` | a note by path, file name, title or alias; `--meta`, `--section`, `--lines` | below |
| `log add <kind> <title>` | record memory as a new file | [memory.md](memory.md) |
| `log [n]`, `log import`, `view`, `export`, `sync` | read, import, render, export and sync memory | [memory.md](memory.md) |
| `lifecycle set\|review\|archive\|restore\|status` | how long a note stays true | [lifecycle.md](lifecycle.md) |
| `lint [--strict]` | vault health, read-only | [lifecycle.md](lifecycle.md#lint) |
| `integrations`, `doctor` | who is connected; this machine's setup | [integrations.md](integrations.md) |
| `context`, `agent install <harness>` | session primer; teach a harness about brain | [agents.md](agents.md) |

## Setup

`brain setup` asks six things, each with a recommended default, and writes nothing until you
confirm the summary:

1. **Vault** — found for you: the folder you are in, Obsidian vaults in iCloud, `~/Documents`,
   `~/Obsidian`, `~/Dropbox`; or type a path.
2. **Machine name** — labels the memory entries written here.
3. **Sync** — how the vault reaches your other machines; recommended from what it detects, with
   a warning if the vault is a git repository inside a cloud folder.
4. **Agents** — install the brain skill for Claude Code, Pi, or the shared `~/.agents/skills`
   (Claude Code's session hook is printed for you to add; brain never edits its settings).
5. **Telemetry** — the opt-in question ([telemetry.md](telemetry.md)).
6. **Shell profile** — add `export BRAIN_VAULT=…` to your shell's startup file, only on yes.

It writes this machine's config (`~/.config/brain/config.json`) — never the vault. The chosen
vault is remembered there, so brain finds it from any folder even without step 6. Without a
terminal it needs `--yes`, with `--vault`, `--machine`, `--sync auto|git|none`,
`--agents claude,pi,agents`, `--telemetry yes|no` and `--profile`.

## Everyday use

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
| 7 | `lint_failed` | `brain lint --strict` found warnings |

`schema` changes only on a breaking change to this shape.
