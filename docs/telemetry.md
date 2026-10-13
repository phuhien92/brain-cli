# Telemetry

brain can collect **anonymous usage data, only if you agree**. It is off by default. The
first time you run brain yourself in a terminal, it asks once:

```text
Help improve brain? Share anonymous usage data: command names, outcomes and versions —
never paths, queries, note titles or content. Details: docs/telemetry.md.
Change your mind any time: brain telemetry enable | disable.
Share anonymous usage data? [y/N]
```

Only `y` or `yes` turns it on; Enter, anything else, or no answer within a minute leaves it
off. Your answer is remembered and the question never comes back.

**Agents, scripts, CI and session hooks are never asked** (no terminal, `--json`, `CI` set,
or `brain context`), so they stay off unless a person opted in on that machine. The question
is not asked during `npm install -g`: npm runs install scripts without a terminal to answer
in, and an agent or CI install would hang waiting.

## Change your mind

```sh
brain telemetry enable             # opt in
brain telemetry disable            # opt out
export DO_NOT_TRACK=1              # always off, whatever else is set
export BRAIN_TELEMETRY=1           # opt in without being asked (or =0 to keep it off)
```

or `"telemetry": true | false` in `~/.config/brain/config.json`. `brain telemetry` shows
whether it is on, why, and how many events are waiting. Managing telemetry is never itself
recorded.

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

## Where it is saved

**On your machine**, in `~/.local/state/brain/` (or `$BRAIN_STATE_DIR`):

| File | Holds |
| --- | --- |
| `telemetry.json` | your choice (yes / no / not asked yet), the random install id, when events were last sent |
| `telemetry-queue.jsonl` | events waiting to be sent, one JSON line each, at most 500 — `brain telemetry show` prints them |

Nothing is written there unless you opted in, apart from your choice itself.

**Remotely: [PostHog](https://posthog.com)** US cloud (`us.i.posthog.com`), the brain-cli
project whose key is `POSTHOG_KEY` in `src/telemetry.ts`. Each event becomes a PostHog event
named `brain_command`:

- **anonymous** — the random install id is the distinct id, and `$process_person_profile:
  false` means PostHog creates no person profile;
- **no location** — `$geoip_disable: true` turns off PostHog's IP-to-location lookup;
- **day only** — the timestamp is the day at noon UTC, never the time you ran the command;
- **only the fields above** — `test/telemetry.test.ts` checks the PostHog payload field by field.

What no client can hide: PostHog receives each send from your IP address, as any web server
would. The brain-cli PostHog project has **"Discard client IP data"** turned on, so it is not
stored. The project key in the code can only send events, never read them; PostHog documents
such keys as safe to publish.

A fork can send to its own PostHog project with `BRAIN_POSTHOG_KEY` and `BRAIN_POSTHOG_HOST`
(EU cloud: `https://eu.i.posthog.com`), turn PostHog off with `BRAIN_POSTHOG_KEY=""`, or send
to any collector that accepts the raw
`brain.telemetry.v1` batch with `BRAIN_TELEMETRY_URL`.

## How it is sent

- Each command **appends one line to a local queue** (`~/.local/state/brain/telemetry-queue.jsonl`)
  after it has finished. A command never waits for the network and never fails because of it
  — which matters inside agent sandboxes that have no network at all.
- At most **once a day**, a detached background process posts the queue to the collector and
  clears it. If that fails, the events stay queued (at most 500; the oldest are dropped).
- The collector is PostHog (see [Where it is saved](#where-it-is-saved)). The test suite and CI
  set `BRAIN_POSTHOG_KEY=""`, so nothing they generate reaches it.
- The question is written to stderr, never stdout, so `--json` output is never affected.
