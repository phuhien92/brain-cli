# Design: extensions and a local web interface

*Status: command extensions (kind 1) are implemented. Hooks (kind 2) and the local UI
remain proposed. See [the extension documentation](../extensions.md) for the shipped contract.*

brain's core should stay small: index, search, get, log, sync, scopes. Most good ideas —
a Granola importer, embeddings, a Readwise sync, a lint rule, a view for a new tool —
belong to the people who want them. This document records the implemented command model and
proposes hooks and a local web page for editing configuration.

## What we can learn from tools that already do this

| Tool | Mechanism | What to take | What to avoid |
| --- | --- | --- | --- |
| **gh** (GitHub CLI) | Extensions are git repos named `gh-<name>` holding an executable; `gh extension install owner/repo`; `gh <name>` runs it | Any language; install from git, pinned; explicit install, not `$PATH` discovery (gh [chose this deliberately](https://github.com/cli/cli/issues/6672)) | — |
| **git / kubectl** | Any `git-<name>` / `kubectl-<name>` on `$PATH` becomes a subcommand | Zero ceremony for local scripts | `$PATH` discovery means anything on the machine can impersonate a command |
| **Claude Code hooks, Pi extensions** | Code runs on lifecycle events (session start, tool call) with JSON in and out | Events are how an extension changes behaviour *inside* a command | Pi runs extensions in-process: a bad extension can crash or block the host |
| **oclif plugins** | npm packages loaded into the CLI's process | Rich, typed API | Ties extensions to one language and to internal APIs that then cannot change |
| **Serena dashboard** | Local web app at `localhost:24282`: status, configuration, logs; some settings editable | A local page is the friendliest way to change config | — |

## Recommendation: process extensions, two kinds, one contract

Every extension is **a separate process** that talks to brain through things that
already exist and are versioned: the `--json` envelope (`brain.v1`), environment
variables, and stdin/stdout. Never in-process code.

Why that and not plugins loaded into brain:

- **Any language.** A Python importer and a Go ranker are equally welcome.
- **brain's internals stay free to change.** The public API is the JSON contract, which
  already has a version and tests. In-process plugins would freeze every internal
  function the day the first plugin imports it.
- **A broken extension cannot break brain.** It times out or exits non-zero; brain
  reports it and carries on. `brain context` in particular must never fail.
- **Zero runtime dependencies survives** (invariant 8): no plugin loader, no module
  resolution, no sandbox runtime.

The cost is process start-up time, so extensions hook **events that are rare relative to
a search**: a note changed, an entry added, a sync finished — not every query.

### Kind 1 — commands: `brain <name>` (implemented)

The shipped install, manifest, launcher, scope and process contracts are documented in
[`docs/extensions.md`](../extensions.md).

Good fits: importers (Granola, Notion, Readwise, Kindle highlights → log entries),
reports, one-off migrations, a `brain bench` for the benchmark.

### Kind 2 — hooks: change what built-in commands do

An extension declares the events it handles. brain runs it with one JSON request on
stdin and reads one JSON response from stdout (`brain.hook.v1`), with a timeout:

| Event | When | The hook can |
| --- | --- | --- |
| `note.indexed` | a note was added or changed (incremental, so rarely) | add derived fields: people, dates, a summary, an embedding id |
| `log.added` | an entry was created | notify, mirror elsewhere, add tags |
| `search.after` | results are ranked, before output | re-rank or add results (embeddings, recency) — opt-in per call: `--with <ext>` |
| `context.build` | building the session primer | add a few lines (today's calendar, open PRs) |
| `sync.after` | a sync finished | push a notification, run a backup |
| `view.render` | rendering a view for export | render another format (Cursor rules, a CLAUDE.md block) |
| `lint.run` | `brain lint` (roadmap step 4) | report findings for its own rules |

Hooks **return data**; brain applies it. A hook never edits the vault directly, so the
"create, never edit" and "never lose an edit" invariants keep holding. Any vault write
a hook wants goes through `brain log add` like everyone else's.

Embeddings are the clearest example: semantic search can arrive as a `note.indexed` +
`search.after` extension with its own model and store, so brain's core keeps no model,
no network and no native dependency, and users who never want it never pay for it.

### Proposed hook manifest addition

Hooks would extend the implemented [`brain-extension.json` contract](../extensions.md#manifest)
with a mapping such as `"hooks": { "context.build": "bin/context-hook" }`. Its exact schema,
permissions and enablement behavior remain to be designed with the first hook.

### Proposed discovery and contribution

No central server at first. Extensions are git repos named `brain-<name>` with the GitHub
topic `brain-extension`, and an `awesome` list in this repo. `brain ext create <name>`
scaffolds a repo with the manifest, a sample command and hook, and a test that runs it
against a fixture vault.

## Local web interface: `brain ui`

Editing JSON by hand is fine for one integration and error-prone for five. Following
Serena's dashboard, `brain ui` starts a local page for the configuration a person would
otherwise hand-edit:

- **Status** — `brain doctor` as a page: vault, index, sync mode, placeholders, warnings.
- **Integrations** — add or edit one (read folders, write kinds, views), with folder
  pickers from the vault and a preview of what it would see (`search` as that integration).
- **This machine** — machine name, view paths, sync override.
- **Extensions** — installed, enabled per vault, their permissions; enable/disable.
- **Search playground** — try a query, compare against grep, see what an integration's
  scope returns. Doubles as the benchmark's manual mode.
- **Log** — recent entries by machine and kind.

Rules it must follow:

- **Bound to 127.0.0.1 only**, random token in the URL, `Host` header checked — a local
  web server is otherwise reachable from any web page the browser opens (DNS rebinding).
- **Every save goes through the same validation as the CLI** (`loadConfig`), shows a diff,
  and writes atomically. It is a front end to the config files, not a second store.
- **No dependency added**: `node:http` and static HTML/JS, in keeping with invariant 8.
- **Off by default**; it runs only while `brain ui` runs.

## Order of work

1. **Lifecycle and lint** (roadmap step 4). Done; the benchmark remains future work.
2. **Extension commands** (kind 1) and the manifest, with `brain ext install/list/remove`.
   Done, designed against the meetings reference extension.
3. **Hooks** (kind 2), one event at a time, starting with `context.build` and `log.added`.
4. **`brain ui`**, once there is enough configuration to deserve a page.

## Open questions

- Should hook output that changes ranking (`search.after`) ever be on by default, or only
  per call? Proposed: per call, so search stays explainable.
- Does a hosted index of extensions ever make sense, or is a GitHub topic enough?

The implemented Windows launcher convention is documented in
[the extension docs](../extensions.md#windows-launchers).
