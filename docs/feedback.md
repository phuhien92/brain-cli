# Feedback: bug reports and ideas, from people and agents

Agents use brain more than people do, so they hit its rough edges first. `brain feedback`
lets them — and you — turn that into a GitHub issue, **without publishing anything from
your vault and without posting unless a person asked for it or allowed it.**

```sh
brain feedback "search returns nothing for quoted phrases with dashes" --kind bug
brain feedback "get --section should accept a heading path" --kind idea
brain feedback "lifecycle example uses the wrong flag" --kind docs
brain feedback "it failed when I searched" --from-last-error   # attach the last failure here
brain feedback list
brain feedback show <id>
brain feedback submit <id>                                     # prints a pre-filled issue link
```

## Drafts are redacted on your machine

A draft lives in `~/.local/state/brain/feedback/`, never in the vault. brain adds
diagnostics itself — brain and Node versions, OS, and with `--from-last-error` the failing
command, its exit code and error code — and redacts the whole draft before anyone sees it:

| Becomes | What |
| --- | --- |
| `<vault>` | the vault's path |
| `<note-N>`, `<note-N-title>` | every indexed note's path and title |
| `~` | your home directory and any `/Users/…` or `/home/…` path |
| `<email>`, `<amount>`, `<number>`, `#<id>` | email addresses, money, long numbers, account-style ids |

Redaction is a safety net, not a guarantee: read the draft (`brain feedback show`) before it
leaves. A fingerprint of the problem (command, error code, version) is included so duplicate
reports are easy to spot.

## Posting: only when a person asked or allowed

- **Default:** `brain feedback submit <id>` prints a link to GitHub's "new issue" page with the
  report filled in. A person opens it, reads it, and clicks *Submit*. No token involved.
- **Posting directly** (`--post`, with the [GitHub CLI](https://cli.github.com)) needs the
  user's permission, one of:
  - they asked for this report to be posted — the agent passes `--user-approved`;
  - they allowed it on this machine: `"feedback": { "post": "allow" }` in
    `~/.config/brain/config.json`.

  Without either, `--post` is refused with exit code 6.

Reports go to `phuhien92/brain-cli` with the labels `agent-report` and the kind;
`BRAIN_FEEDBACK_REPO=owner/repo` sends them to a fork instead.
