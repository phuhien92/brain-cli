# Memory across machines

An agent's memory is usually one file — `learnings.md`, `MEMORY.md` — that every session
appends to. Put that file in git and use it from two machines, and the first sync is a
merge conflict: both machines appended to the same place.

`brain` stores memory as a **log of one file per entry** instead:

```sh
brain log add learning "pnpm cache breaks after macOS updates" --body "Run pnpm store prune." --tag ops
# → log/learning/2026-10-13-mac-mini-pnpm-cache-breaks-after-macos-updates.md
brain log 5                      # recent active entries, any kind
brain log retire log/learning/<entry-id>.md --reason "obsolete"
brain log replace log/learning/<entry-id>.md --text "corrected title" --body "corrected detail"
brain view learning              # every active learning, oldest first, as one markdown list
brain sync                       # commit new entries, pull --rebase, push, re-export
```

Ordinary entries include the machine and timestamp in their paths, so two machines do not
create the same file. The single-file shape that existing tools expect is *generated* from
the log, so it is never edited by two machines either. Every active entry renders as its
own bullet, including identical entries created on different machines, so each bullet can
be retired or replaced independently. Each entry records which machine wrote it. Source
importers can instead request a deterministic, create-only path with
`--source-id`; matching imports then merge as the same file, while different content for one
source ID deliberately produces a sync conflict. See [Command extensions](extensions.md#process-contract).

- **`brain sync`** follows the vault's `"sync"` mode, because files reach other machines
  in many ways: `git` (any remote) commits only the log folder, ingested `sources/` pairs and
  `brain.json` — never a note you are halfway through — then pulls with rebase and pushes, stopping with exit 5
  and the file names if a *note* was edited on both machines; `none` leaves moving files
  to iCloud, Dropbox, Syncthing or Obsidian Sync; `{ "command": … }` runs yours. `auto`
  (the default) picks git when the vault is a git repository.
- **`brain export`** writes a view to a path outside the vault as a regular file (not a
  symlink — some tools rightly refuse those). If that file was edited since brain last
  wrote it, it refuses, because those edits are not in any entry yet. Capture them with
  `brain log import`, then `brain export --force`.
- **`brain log import <kind> <file>`** turns an existing memory file into entries, one per
  top-level list item, dropping HTML-comment markers from titles. Matching title-and-body
  occurrences with active entries are skipped, while surplus identical list items become
  separate entries. Title plus body is an entry's identity. Entries brain exported to that file and later removed
  from it are listed as retirement candidates; an exported entry whose title remains with a
  new body is a replacement candidate, not imported until `log replace` records it. Duplicate
  titles are not guessed: ambiguous old entries are retirement candidates and new entries are
  imported normally. Entries the file never held are never proposed, and import never retires
  anything automatically.
- **`brain log retire <entry-id> [--reason …]`** records an immutable lifecycle event;
  views and exports omit the entry while its original file remains untouched.
  **`brain log replace <entry-id> --text <title> [--body <text|->]`** adds the corrected
  entry and retires the old one. `--text` is always the title; omit `--body` for an empty
  body, or use `--body -` to read the body from stdin.
  Concurrent retirements create separate event files and do not conflict.

Configuration is split by what may travel: `brain.json` in the vault (the same on every
machine) and `~/.config/brain/config.json` on each machine (its name and the paths that
exist only there). A view that a tool needs as a file is declared by the integration that
uses it — see [integrations.md](integrations.md):

```jsonc
// <vault>/brain.json
{ "integrations": { "firstmate": { "read": ["firstmate/"], "write": ["learning", "lifecycle"],
    "views": { "learning": { "header": "<!-- memory tiers: see the stow skill -->" } } } } }

// ~/.config/brain/config.json — this machine only ($BRAIN_CONFIG overrides the path)
{ "machine": "mac-mini",
  "integrations": { "firstmate": { "views": { "learning": "~/firstmate/data/learnings.md" } } } }
```

[the firstmate guide](firstmate.md) walks through moving
[firstmate](https://github.com/kunchenguid/firstmate)'s fleet learnings onto two machines.
