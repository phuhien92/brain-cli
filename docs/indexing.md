# How the index stays up to date

Short answer: **every command checks first.** brain has no watcher and no background
process; before a command answers, it compares every note on disk with what the index
knows and re-reads only what changed. The index cannot be stale at the moment it is read.

## The mechanism

Borrowed from [Serena](https://github.com/oraios/serena): index once up front, then keep the
index current as a side effect of using it.

1. **Stat every note.** For each `.md` file (dot-folders and `node_modules` skipped),
   compare modification time and size with the index. Equal → skip. This is the whole
   cost when nothing changed.
2. **Hash what looks changed.** If time or size differs, read the file and compare its
   SHA-256 with the stored one. Same content (a `git checkout`, a sync service touching
   timestamps) → update the timestamp only, no re-parse.
3. **Re-parse what really changed**: title, aliases, headings, tags, wiki-links, and the
   full-text row. One transaction for the whole refresh.
4. **Drop what is gone** — except notes a cloud service has evicted to a placeholder
   (`.Name.md.icloud`), which stay indexed so search keeps finding them.

The index lives **outside the vault** (`~/.local/state/brain/<vault>-<id>/index.db`), one per
machine, because vaults are synced and a synced SQLite file corrupts. A schema change
rebuilds it automatically; `brain index --rebuild` does it by hand. Deleting it is always
safe.

## What it costs

Measured on Linux (Node 22), every command including Node start-up (~0.07 s):

| Vault | First build | Check, nothing changed | After 5 edits | A search, check included |
| --- | --- | --- | --- | --- |
| 127 notes (a real Obsidian vault) | 0.13 s | ~0.01 s | — | — |
| 20,000 notes (synthetic, 83 MB) | 4.6 s | 0.32 s | 0.42 s | 0.49 s |

`brain index --verify` (hash every note, below) took 0.85 s on the 20,000-note vault.
Timings for a real vault's notes copied up to 20,000 are in [the benchmark](benchmark.md#scale-what-happens-at-thousands-of-notes).

For personal vaults — hundreds to a few thousand notes — the check is noise. At tens of
thousands it is a third of a second per command: acceptable for an agent, noticeable if it
calls brain many times in a row.

## The one blind spot, and `--verify`

The quick check trusts that an edit changes the modification time or the size. An edit
that keeps both — a same-length change within one timestamp tick, or a sync tool that
restores the original timestamp and the length happens to match — passes unseen until
the next real change. It is rare, and `brain index --verify` closes it: it ignores the
quick check and hashes every note. Worth running from a nightly job, or after a large
sync.

## Options for much larger vaults (not built)

Ranked by what they would cost to keep correct:

1. **Opt-in watch mode (`brain watch`).** A long-running process using the OS's file
   events (FSEvents on macOS, inotify on Linux, via `fs.watch` recursive) keeps the index
   hot; commands see a fresh heartbeat and skip the walk, and fall back to the walk when
   the watcher is not running. Fastest, but a daemon is new failure surface (missed events
   after sleep, event floods during a sync), so the walk stays the source of truth.
2. **git-aware change detection.** For git vaults, `git status` plus the HEAD diff since
   the last indexed commit names exactly what changed. Fast and exact, but only for git, and
   brain does not assume git.
3. **A freshness window.** Skip the walk if the last one was under N seconds ago. Cheapest,
   but gives up "never stale when read", so it would be off by default and per call.

Not an option: pruning by directory modification time. A folder's time changes when files
are added or removed, not when one is edited, so it cannot prove a folder is unchanged.

The recommendation: keep the per-command check as the default, and add `brain watch` as
an opt-in only when someone's vault makes the check hurt.

## What gets indexed

Each note's title (frontmatter `title`, else the first `# H1`, else the file name),
aliases, headings, tags (frontmatter and inline `#tags`, ignoring code), and wiki-links
(`[[target#heading|alias]]`, embeds included). Search is SQLite FTS5 with Porter stemming
("designing" finds "design"), ranked by BM25 with titles and aliases weighted above
headings and tags, and those above body text.

## Why no vector database (yet)

The caller is an LLM. When a keyword search comes back thin, it rephrases — "why did the
build break" becomes "pnpm cache" — at almost no cost, which covers most of what embeddings
would. Keyword search is also deterministic, explainable (the snippet shows why a note
matched), needs no model download or API key, and never sends a note to a third party. If
the benchmark shows paraphrased questions failing, semantic search arrives as an optional
extension ([design/extensions.md](design/extensions.md)), not in the core.
