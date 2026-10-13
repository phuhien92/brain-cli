# Sources and provenance

Notes often summarise a paper, meeting transcript or specification. `brain ingest` keeps
that original beside the notes so a person or agent can check the claim later.

```sh
brain ingest ~/Downloads/paper.pdf --title "Paper title"
brain ingest notes.md --tag reading --tag project-x
```

The command copies the bytes without interpreting them. It does not fetch URLs or extract
text from PDFs or images. Each ingest creates two files with exclusive (`wx`) creates:

```text
sources/2026-10-13-mac-mini-paper-title.pdf
sources/2026-10-13-mac-mini-paper-title.pdf.source.md
```

Find the folder without hard-coding the vault path with `brain path sources`.

The first file is the unchanged original. The second is a markdown sidecar containing `title`,
`ingested`, `machine`, `origin`, `sha256` and `tags`. Search indexes the sidecar, never the
original – including when the original itself is markdown. A file in `sources/` counts
as an ingested original only when its `.source.md` sidecar exists; any other markdown you
keep there stays an ordinary note that brain indexes, lints and leaves out of sync. The SHA-256 digest is the
source's stable `id` in JSON output:

```json
{"path":"sources/2026-10-13-mac-mini-paper-title.pdf","id":"…","new":true}
```

Ingesting the same bytes again returns the existing path and `"new": false`; it writes
nothing. Different files with the same title get a numeric suffix. Existing files are
never replaced. Machine names in file names let two machines ingest concurrently without
a path conflict. Git-mode `brain sync` owns and commits each sidecar and its original along with the log
folder and `brain.json`; other sync modes move the same files through the user's chosen
service.

## Cite a source

A normal wiki-link to the original is a citation:

```markdown
The protocol uses bounded retries. [[sources/2026-10-13-mac-mini-paper-title.pdf]]
```

Or put one or more wiki-links in `sources:` frontmatter:

```yaml
---
sources:
  - "[[sources/2026-10-13-mac-mini-paper-title.pdf]]"
  - "[[sources/2026-10-13-mac-mini-meeting-notes.txt]]"
---
```

A file name without the `sources/` prefix also resolves under the usual wiki-link rules,
but the full vault-relative path remains clear when names are similar.

## Lint provenance

`brain lint` adds three rules:

- `source-missing` (warn) – a wiki-link in `sources:` resolves to no note or file.
- `source-modified` (warn) – a sidecar is missing its original, or the original's bytes no
  longer match the recorded SHA-256 digest.
- `unsourced` (info) – a note in an opted-in folder has neither a `sources:` entry nor a
  normal wiki-link that resolves to an ingested source.

Opt folders into `unsourced` in the vault's synced `brain.json`:

```json
{
  "lint": {
    "unsourced": ["Research/", "Decisions/"]
  }
}
```

Folder paths are vault-relative; source sidecars themselves are excluded. `--strict` fails only for warn-level findings, so an
`unsourced` information finding does not change its exit status.
