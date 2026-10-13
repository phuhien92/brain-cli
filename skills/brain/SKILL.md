---
name: brain
description: Search and update the user's personal notes and long-term memory with the `brain` CLI. Use when the user asks about their notes, past decisions, preferences, plans, people, projects, or anything they have told you or written down before ("what did I decide about…", "do I have notes on…", "remind me…"); before answering from general knowledge something that may be recorded in their vault; and when you learn a durable fact or lesson worth keeping across sessions and machines.
compatibility: Requires the brain CLI (Node.js 22.13+) — npm install -g github:phuhien92/brain-cli — and a vault set with $BRAIN_VAULT or found from the working directory.
---

# brain — the user's notes and memory

> Source of truth: [phuhien92/brain-cli](https://github.com/phuhien92/brain-cli/blob/main/skills/brain/SKILL.md).
> If `brain` is not installed (`command -v brain` fails), say so and fall back to `grep`.

`brain` is a CLI over the user's markdown vault (an Obsidian vault or similar). It ranks
notes by relevance, keeps its own index fresh, and needs no app running. Prefer it to
`grep` for questions; use `grep` only for an exact string (a file name, an ID, a quoted
phrase).

## Find something

1. `brain search "<the question in plain words>" --json --limit 5`
   Results are ranked; each has `path`, `title`, `score` and a `snippet` with the matched
   words in `[brackets]`. Titles and headings count more than passing mentions.
2. Read the one or two that look right: `brain get "<path>" --json` (`data.content`).
3. If nothing fits, **rephrase before concluding it is not there**: use the words the
   user would have written in a note ("COBRA" rather than "health insurance after
   layoff"), a synonym, or a narrower term. Try two or three phrasings.
4. Narrow when results are noisy: `--path "<folder>"`, `--tag <tag>`.
5. Cite the note path you relied on, so the user can open it.

For a long note, read only what you need: `brain get "<path>" --section "<heading>" --json`
(repeatable; `--meta` lists the headings first; `--lines <n>` keeps only the first n lines
of each section, which is all you need from a newest-first log).

`brain get` accepts a path, a file name, a note title or an alias. Exit code 4 means the
name matched several notes; pick one from `error.candidates`.

## Remember something

When you learn something durable — a lesson, a decision, a gotcha, a stated preference —
and the user wants it kept (or has asked you to keep such things):

```sh
brain log add learning "<one line, written to be useful out of context>" --body "<detail>" --tag <topic>
```

Use `decision` or another short kind when `learning` does not fit. Each entry is a new
file, so this is always safe, even from two machines. Never edit an existing entry, and
never edit a file the user has told you brain generates (for example a `learnings.md`
exported for another tool): add an entry instead.

`brain log 10` shows recent entries; `brain sync` shares them with the user's other
machines (commit, pull, push). Run `brain sync` only if the user's setup says to.

## Rules

- The vault is personal. Do not copy its contents into anything that leaves the machine
  (an issue, a PR, a web request) unless the user asks.
- Every command takes `--json` and returns `{ "ok": true, "data": … }` or
  `{ "ok": false, "error": { "code", "message" } }`. Exit codes: 0 ok, 1 error, 2 usage,
  3 not found, 4 ambiguous, 5 conflict.
- `brain help` lists everything.
