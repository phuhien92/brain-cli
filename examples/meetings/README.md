# `brain meetings` reference extension

This kind-1 extension imports source-provided meeting summaries into the `meeting` log:

```sh
brain ext install ./examples/meetings   # review and approve in a terminal
BRAIN_MEETINGS_API_URL=http://127.0.0.1:3000/meetings \
  brain meetings import --since 7d
```

The endpoint returns `{ "meetings": [...] }`, where each item has `id`, `title`, `date`,
`attendees`, `summary`, `actionItems`, and `url`. The example intentionally has no live
account setup or credentials; its tests use a local fake server.

Only the source summary, action items, attendees, date, and link are written. A
`transcript` field in the response is ignored. Source IDs are stored only as hashes and
make repeated imports idempotent. The child `brain log add` call inherits the extension
scope and asks core to redact sensitive values before it creates a note.
