# Changelog

Every release is a git tag `v<version>`. Install a specific one with
`npm install -g github:phuhien92/brain-cli#v<version>`.

## 0.11.0 (2026-10-14)

- `brain update [--check]`: is a newer release out? Once a day brain checks GitHub in the
  background and tells a person at a terminal, on stderr. `brain doctor` reports it for
  agents. Off with `BRAIN_NO_UPDATE_CHECK=1` ([docs/updates.md](docs/updates.md)) (#17).
- `brain bench`: deterministic search benchmark (#13, issue #1).
- Extensions: `brain ext install/list/remove`, extension commands, and the `brain meetings`
  example (#11, issue #3).
- `brain log retire` and `brain log replace` (#10, issue #2).
- `brain ingest` and provenance lint rules (#9, issue #6).
- Install from GitHub needs no build tools (#8).
- `brain path` (issue #7).

## 0.10.0 and earlier

Core indexing and search, memory that syncs across machines, integrations and scopes,
lifecycle and lint, agent setup, feedback, opt-in telemetry and `brain setup`.
