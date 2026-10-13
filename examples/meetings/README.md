# `brain meetings` reference extension

This kind-1 extension imports source-provided meeting summaries into the `meeting` log:

```sh
brain ext install ./examples/meetings   # review and approve in a terminal
BRAIN_MEETINGS_API_URL=http://127.0.0.1:3000/meetings \
  BRAIN_EXTENSION_TIMEOUT_MS=300000 \
  brain meetings import --since 7d
```

The endpoint returns `{ "meetings": [...] }`, where each item has `id`, `title`, `date`,
`attendees`, `summary`, `actionItems`, and `url`. The example intentionally has no live
account setup or credentials; its tests use a local fake server. `date` accepts an ISO date or
timestamp and is stored as a canonical UTC timestamp.

`BRAIN_EXTENSION_TIMEOUT_MS` raises the parent deadline for large import windows; omit it to use
brain's 30-second default.

Only the source summary, action items, attendees, date, and link are written. A
`transcript` field in the response is ignored. Source IDs are stored only as hashes through
`brain log add --source-id --source-created`, whose create-only path makes repeated and concurrent
imports idempotent while retaining source chronology. The child call inherits the extension scope and asks core to redact sensitive
values before it creates a note.
