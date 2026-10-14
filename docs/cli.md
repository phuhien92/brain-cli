# Command reference

`brain help` prints the same list with every flag. All commands take `--json`, `--quiet`,
`--vault <dir>` and `--as <integration>`.

| Command | What it does | More |
| --- | --- | --- |
| `setup [--yes …]` | first-run walkthrough: vault, machine, sync, agents, telemetry, shell profile | [setup](#setup) |
| `index [--rebuild\|--verify]` | bring the index up to date (every command does this first) | [indexing.md](indexing.md) |
| `search <query>` | ranked full-text search; `--limit`, `--path`, `--tag`, `--raw`, `--include-archived` | below |
| `get <note>` | a note by path, file name, title or alias; `--meta`, `--section`, `--lines` | below |
| `ingest <file>` | immutably copy a local source; `--title`, repeatable `--tag` | [sources.md](sources.md) |
| `log add <kind> <title>` | record memory as a new file | [memory.md](memory.md) |
| `log retire <entry-id> [--reason …]`, `log replace <entry-id> --text … [--body …]` | retire or replace an entry through immutable lifecycle events | [memory.md](memory.md) |
| `log [n]`, `log import`, `view`, `export`, `sync` | read, import, render, export and sync active memory | [memory.md](memory.md) |
| `lifecycle set\|review\|archive\|restore\|status` | how long a note stays true | [lifecycle.md](lifecycle.md) |
| `lint [--strict]` | vault health, read-only | [lifecycle.md](lifecycle.md#lint) |
| `integrations`, `doctor` | who is connected; this machine's setup | [integrations.md](integrations.md) |
| `path [<name>]` | where brain keeps things on this machine; reads only | [below](#where-things-are) |
| `context`, `agent install <harness>` | session primer; teach a harness about brain | [agents.md](agents.md) |
| `ext install\|list\|remove` | manage per-machine command extensions and per-vault enablement | [extensions.md](extensions.md) |

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
brain ingest paper.pdf --title "Paper title" --tag reading
brain log add learning "..."     # record memory (see below)
brain sync                       # share it with your other machines
```

The vault is `--vault <dir>`, else `$BRAIN_VAULT`, else the nearest parent folder holding
`.obsidian/` or a `brain.json`.

## Where things are

`brain path` prints the locations brain uses, resolved the same way every command
resolves them (`--vault`, `BRAIN_VAULT`, `BRAIN_CONFIG`, `BRAIN_STATE_DIR`, `brain.json`'s
`log.dir`). Scripts and agents should ask rather than hard-code a path: the state
directory's name is derived from the vault's real path, and every one of these can be
overridden.

| Name | What it is |
| --- | --- |
| `vault` | the vault in use |
| `log` | the log folder: one file per memory entry |
| `sources` | immutable originals and their metadata sidecars |
| `config` | the vault's `brain.json`, synced with it |
| `user-config` | this machine's config |
| `extensions` | per-machine installed extension code |
| `state` | this vault's state directory, outside the vault and never synced |
| `index` | the search index inside it |
| `telemetry-queue` | anonymous usage events waiting to be sent, if you opted in |

```sh
cd "$(brain path log)"          # one name: the bare path, nothing else
brain path                      # all of them, marking any not created yet
brain path --json               # { "paths": { "log": { "path": "…", "exists": true }, … } }
```

It only reads. Printing a location never creates it, and an unknown name exits 2 with
the list of valid ones. Under `--as`, the paths are the same and `--json` adds `"as"`, so
an agent knows its reads through brain are scoped.

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
| 1 | `no_vault`, `internal`, `install_failed`, `extension_failed`, `extension_protocol`, `extension_timeout`, `extension_output_limit` | no vault, an unexpected failure, or an extension install/runtime failure |
| 2 | `usage`, `bad_query`, `invalid_manifest` | bad arguments, invalid `--raw` FTS5 syntax, or an invalid extension manifest |
| 3 | `not_found` | a note, extension installation, or vault enablement was not found |
| 4 | `ambiguous` | `get` matched several notes; `error.candidates` lists their paths |
| 5 | `sync_conflict`, `export_drift`, `install_conflict`, `enablement_conflict` | synced or installed content conflicts with existing content, or an exported file drifted |
| 6 | `not_permitted`, `permission_confirmation_required` | the acting integration may not write that kind, or extension installation needs an interactive person |
| 7 | `lint_failed` | `brain lint --strict` found warnings |

`brain.v1` may gain optional fields, so consumers must ignore fields they do not
recognize. Removing, renaming or retyping a field, or changing an exit code, is breaking
and bumps `schema`.
