# Sharing firstmate's memory across machines

[firstmate](https://github.com/kunchenguid/firstmate) keeps its curated fleet knowledge in
`data/learnings.md`, which is gitignored and local to one firstmate home. Run firstmate on
a Mac mini and a laptop and each machine learns separately.

This guide moves that knowledge into a brain vault so both machines share it, without
changing firstmate. firstmate keeps reading an ordinary `data/learnings.md`; brain
generates it from a log that syncs through git.

## What moves, and what stays

| firstmate file | Shared? | Why |
| --- | --- | --- |
| `data/learnings.md` | **yes**, generated from `log/learning/` | fleet knowledge is the same on every machine |
| `data/captain.md` | not yet | you edit it by hand and rarely; copying it once is enough for now |
| `state/`, `projects/`, worktrees | **no** | work in flight is tied to the machine running it |

firstmate treats a **symlinked** memory file as unsafe (its startup check reports
`unsafe memory data/learnings.md`), so brain writes `learnings.md` as a regular file
instead of linking it.

## Prerequisites

- Your vault reaches both machines somehow — git, iCloud, Dropbox, anything; set
  `"sync"` in `brain.json` to match ([integrations.md](integrations.md#how-the-vault-reaches-other-machines)).
  brain keeps its index outside the vault, so there is nothing to ignore.
- `brain` installed on both machines (`npm install -g github:phuhien92/brain-cli`).

## 1. Declare firstmate, then configure each machine

In the vault's `brain.json` (it travels with the vault):

```json
{
  "integrations": {
    "firstmate": {
      "read": ["firstmate/"],
      "write": ["learning"],
      "views": { "learning": { "header": "<!-- memory tiers: see the stow skill -->" } }
    }
  }
}
```

`~/.config/brain/config.json` on the **Mac mini**:

```json
{
  "machine": "mac-mini",
  "integrations": {
    "firstmate": { "views": { "learning": "~/firstmate/data/learnings.md" } }
  }
}
```

The laptop's is the same with `"machine": "laptop"` and its own firstmate path. This file
never syncs: it names the machine and paths that only exist there.

Point brain at the vault in your shell profile on both machines:

```sh
export BRAIN_VAULT=~/vault
```

Set `BRAIN_AS=firstmate` **only where firstmate's agents run** — the firstmate repo's
`.claude/settings.json` (`{ "env": { "BRAIN_AS": "firstmate" } }`) or the environment it
launches crewmates with. Never in your shell profile: that would scope every agent on the
machine, including your own sessions over the whole vault.

See [integrations.md](integrations.md) for what a scope does and does not protect.

## 2. Capture what each machine already knows

On the **Mac mini**:

```sh
brain log import learning ~/firstmate/data/learnings.md
brain sync
```

Then on the **laptop** — sync first, so learnings the Mac mini already recorded are
skipped rather than duplicated:

```sh
brain sync
brain log import learning ~/firstmate/data/learnings.md
brain sync
```

Each top-level bullet becomes one entry under `log/learning/`. stow's tier markers
(`<!--a:2026-08-03-->`) are dropped from the titles.

Run `brain sync` once more on the Mac mini. Both `learnings.md` files are now generated
from the same log and are byte-identical.

## 3. Tell firstmate to write through brain

Add this to `data/captain.md` on each machine (it is firstmate's record of your
preferences, read every session):

```markdown
- Record durable fleet learnings with `brain log add learning "<one line>" [--body "<detail>"]`.
  Never edit data/learnings.md directly: brain regenerates it from the shared log.
- Run `brain sync` at the start and end of each session.
```

Optionally, back it up with a cron job so a machine that was off catches up on its own:

```cron
17 * * * * BRAIN_VAULT=$HOME/vault /usr/local/bin/brain sync -q
```

## When something edits learnings.md anyway

firstmate's `/stow` curates `learnings.md` in place. If it does, the next `brain sync` or
`brain export` sees that the file changed since brain wrote it and **refuses to overwrite
it** — those edits are not in the log yet. To capture the curation and re-export:

```sh
brain log import learning ~/firstmate/data/learnings.md
# Adds new bullets and lists active logged entries not present in the file.
# Absence alone does not prove /stow removed one; review each before retiring it:
brain log retire log/learning/<entry-id>.md --reason "removed by /stow"
brain export --force
```

`import` never retires anything automatically. If a title stays the same but its indented
body changes, import adds the new text and lists the old entry as a candidate. For a direct
rewording that has not already been imported, replace the old entry in one command instead;
the first line is the new title and later lines are the new body:

```sh
brain log replace log/learning/<entry-id>.md --text 'the corrected learning
supporting detail'
```

Both commands leave the original entry untouched and add lifecycle files under
`log/lifecycle/`. After `brain sync`, every machine's generated view omits the retired
entry. If two machines retire the same entry before syncing, both events remain valid and
do not conflict.
