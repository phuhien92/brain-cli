# Keeping the vault true

Notes go stale. A balance from July, a manager fee from before you switched — an agent
will quote them with full confidence unless something says otherwise.

```sh
brain lifecycle set "Finance/robinhood" --category current-state --as-of 2026-07-24
brain lifecycle review "Finance/robinhood"          # confirmed still true today
brain lifecycle archive "Old plan" --reason "superseded by the split coaching state"
brain lifecycle status --due                        # what needs a look
brain lint                                          # broken links, conflict copies, overdue reviews…
```

| Category | Review after | For |
| --- | --- | --- |
| `memory`, `identity`, `preference`, `principle` | never | lasting facts, who you are, how you like things, rules |
| `research` | 180 days | articles, plans, analysis |
| `current-state` | 30 days | balances, statuses, who manages what |
| `news` | 14 days | digests, announcements |

Windows are configurable (`brain.json`: `"lifecycle": { "windows": { "current-state": 60 } }`).
A category can also be written by hand in a note's frontmatter (`category:`, `as-of:`,
`reviewed:`, `archived: true`).

What changes for agents: search and `get` carry each note's `lifecycle`; an overdue note
is marked stale, an archived one is hidden from search, and the session primer says how
many notes are past review. The `brain` skill tells agents to say a fact may be out of
date rather than state it.

`lifecycle` commands never edit a note. Each change is a new entry in `log/lifecycle/`,
so two machines reviewing notes never conflict, and every change has a date, a machine
and a reason.

## Lint

`brain lint` reports, without changing anything: broken links (a link that names an
existing file without its extension counts as resolved), notes nothing links to, sync
conflict copies (`Note 2.md`, Dropbox "conflicted copy", Syncthing `.sync-conflict-`),
overdue reviews and lifecycle problems, source citations and immutable-source hashes,
and per-file line limits you set (`"lint": { "maxLines": { "MEMORY.md": 150 } }`).
Folders can opt into info-level `unsourced` findings. See [sources.md](sources.md).
`--strict` exits 7 on warnings, for a scheduled job.
