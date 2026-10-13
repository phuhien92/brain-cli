# Telemetry

brain collects **anonymous usage data, on by default**. This page lists everything that is
sent, so you can decide; the CLI shows the same thing on your machine with
`brain telemetry show`.

## Turn it off

Any one of these:

```sh
brain telemetry disable            # remembered on this machine
export DO_NOT_TRACK=1              # the cross-tool convention
export BRAIN_TELEMETRY=0
```

or `"telemetry": false` in `~/.config/brain/config.json`. `brain telemetry` shows whether it
is on, why, and how many events are waiting.

## Exactly what one event contains

One event per command, nothing more:

| Field | Example | Why |
| --- | --- | --- |
| `schema` | `brain.telemetry.v1` | so the format can change safely |
| `install` | a random UUID | count installs without knowing who; new one with `brain telemetry reset` |
| `day` | `2026-10-13` | the date only, never the time of day |
| `command` | `search`, `log.add` | which features are used; only names from brain's own list of commands, never what you typed |
| `exit`, `error` | `3`, `not_found` | which failures happen; the error *code*, never its message |
| `ms` | `<500` | a bucket, to find slow paths |
| `notes` | `<1k` | the vault's size as a bucket, never a count |
| `sync`, `integrations`, `scoped` | `git`, `2`, `false` | which setups exist; never integration names |
| `json` | `true` | agents vs. people |
| `version`, `node`, `os` | `0.8.0`, `22`, `darwin-arm64` | what to support |

**Never sent:** paths, file or note names, note titles or content, search queries, log
entries, vault names, machine names, hostnames, usernames, environment variables, error
messages.

One thing no client can hide: like any web request, the daily send reveals your IP address
to the collector. Events do not contain it, and the collector must not store it; that rule
will be part of the collector's published configuration.

These guarantees are tested: `test/telemetry.test.ts` searches a vault for a private note
and fails if the query, the note's name or folder, the vault path, the hostname or the
machine name appears anywhere in the queued events.

## How it is sent

- Each command **appends one line to a local queue** (`~/.local/state/brain/telemetry-queue.jsonl`)
  after it has finished. A command never waits for the network and never fails because of it
  — which matters inside agent sandboxes that have no network at all.
- At most **once a day**, a detached background process posts the queue to the collector and
  clears it. If that fails, the events stay queued (at most 500; the oldest are dropped).
- **No collector is configured in this version**, so nothing is sent yet: events stay in the
  local queue until a collector exists. The collector's URL will be listed here when it does.
- The first time brain records an event, it says so once on stderr (never stdout, so `--json`
  output stays clean).
