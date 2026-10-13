# Memory across machines

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
  in many ways: `git` (any remote) commits only the log folder, `sources/` and
  `brain.json` — never a note you are halfway through — then pulls with rebase and pushes, stopping with exit 5
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

Configuration is split by what may travel: `brain.json` in the vault (the same on every
machine) and `~/.config/brain/config.json` on each machine (its name and the paths that
exist only there). A view that a tool needs as a file is declared by the integration that
uses it — see [integrations.md](integrations.md):

```jsonc
// <vault>/brain.json
{ "integrations": { "firstmate": { "read": ["firstmate/"], "write": ["learning"],
    "views": { "learning": { "header": "<!-- memory tiers: see the stow skill -->" } } } } }

// ~/.config/brain/config.json — this machine only ($BRAIN_CONFIG overrides the path)
{ "machine": "mac-mini",
  "integrations": { "firstmate": { "views": { "learning": "~/firstmate/data/learnings.md" } } } }
```

[the firstmate guide](firstmate.md) walks through moving
[firstmate](https://github.com/kunchenguid/firstmate)'s fleet learnings onto two machines.
