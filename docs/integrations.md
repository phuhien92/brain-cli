# Connecting a repo to the vault

One vault, many tools. Each repo or tool that uses the vault (an agent orchestrator, a
coaching skill, a scheduled job) is an **integration**: a named block of configuration
that says what it may read, what it may write, and where its files go on each machine.

Adding one is configuration, never code. Removing one is deleting its block.

## The three steps

### 1. Declare it in the vault's `brain.json`

This file travels with the vault, so every machine sees the same declarations.

```json
{
  "integrations": {
    "interview-coach": {
      "read": ["Career HQ/"],
      "write": ["interview"]
    },
    "firstmate": {
      "read": ["firstmate/", "Build Ideas HQ/"],
      "write": ["learning"],
      "views": { "learning": { "header": "<!-- memory tiers: see the stow skill -->" } }
    }
  }
}
```

- **`read`** — vault folders it may search and open. `["*"]` means the whole vault. It can
  always read the log entries of the kinds it writes, so `read` can be empty.
- **`write`** — log kinds it may add (`brain log add <kind> …`). Each kind is its own
  folder under `log/`, so integrations never write the same files.
- **`views`** — kinds it needs as a single generated file (for tools that read one
  `learnings.md`), with an optional header line.

### 2. Give its paths on each machine

Paths differ per machine, so they live in the machine-local config
(`~/.config/brain/config.json`), never in the vault:

```json
{
  "machine": "mac-mini",
  "integrations": {
    "firstmate": { "views": { "learning": "~/firstmate/data/learnings.md" } }
  }
}
```

An integration with no views needs nothing here.

### 3. Tell the repo's agents who they are

Set `BRAIN_AS=<name>` in the environment its agents run with — for Claude Code, in the
repo's `.claude/settings.json`:

```json
{ "env": { "BRAIN_AS": "interview-coach" } }
```

From then on, every `brain` call from that repo is scoped: `search`, `get`, `log` and
`context` see only its folders, and `log add` accepts only its kinds. `--as <name>` does
the same for a single command.

Check the result with `brain integrations` (who is connected, on this machine) and
`brain doctor`.

## What a scope is, and is not

A scope controls **what brain returns**. A note outside it is reported as *not found*,
so a scoped agent cannot even probe for it, and an out-of-scope write is refused with
exit code 6.

It is **not a sandbox**. An agent with shell access can still `cat` a file brain would
not show it. Real isolation comes from where the agent runs and what its harness lets it
read — a worktree, a container, file permissions. Use scopes to keep well-behaved agents
focused and out of your private notes; use the harness to contain the rest.

## How the vault reaches other machines

brain does not assume a sync service. Set it once in `brain.json` (a machine can override
it in its own config):

| `"sync"` | What `brain sync` does | Use when |
| --- | --- | --- |
| `"auto"` (default) | git if the vault is a git repository, otherwise none | you have not decided |
| `"git"` | commits new log entries, pulls with rebase, pushes | GitHub, GitLab, any git remote |
| `"none"` | refreshes the index and re-exports views; moves nothing | iCloud, Dropbox, Syncthing, Obsidian Sync move the files |
| `{ "command": "…" }` | runs your command in the vault, then refreshes and exports | anything else; it gets `BRAIN_VAULT`, `BRAIN_LOG_DIR`, `BRAIN_MACHINE` |

Whatever moves the files, three things keep it safe: log entries are always new files,
so no two machines edit the same one; the index lives outside the vault on each machine;
and an export never overwrites a file someone edited.

Two cloud-folder cases `brain doctor` checks for:

- **Placeholders.** iCloud's "Optimize Mac Storage" replaces notes you have not opened
  with `.Name.md.icloud`. brain keeps what it last indexed, so search still finds them,
  but cannot read them; `get` says so and how to download.
- **git inside a synced folder.** Two sync systems on one folder can corrupt `.git`.
  Keep the git clone outside the cloud folder, move `.git` to `.git.nosync` with a
  `.git` symlink (iCloud skips `.nosync`), or choose one system.

## Worked examples

- [firstmate](firstmate.md) — fleet learnings shared across two machines, exported as
  the regular `data/learnings.md` firstmate expects.
- interview-coach — reads `Career HQ/`, records `interview` entries; its session start
  reads only the index sections it needs (`brain get --section`).
