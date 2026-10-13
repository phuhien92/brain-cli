# Command extensions

Kind-1 extensions are implemented. They add `brain <name>` commands without loading
third-party code into brain's process. Hooks and the local web interface remain design work in
[`design/extensions.md`](design/extensions.md).

## Install, inspect, remove

```sh
brain ext install ./my-extension
brain ext install https://github.com/example/brain-example.git
brain ext list
brain ext remove example
```

Installation works only in an interactive terminal. brain copies a local directory or clones a
Git URL into this machine's extension data directory, shows the manifest's read, write, and
network permissions, and asks the person to approve. There is no `--yes` or JSON-mode approval:
agents, scripts, CI, and hooks cannot silently grant permissions.

Installed code is per machine (`~/.local/share/brain/extensions` by default, overridable with
`BRAIN_EXTENSIONS_DIR`). A Git install records its exact commit; a local install is a copy, not a
link to mutable source. Approval also adds the extension's name to the current vault's synced
`brain.json`:

```json
{ "extensions": ["example"] }
```

That list is per vault, so work and personal vaults can enable different commands. `ext remove`
removes only this machine's copy. It deliberately leaves `brain.json` unchanged because other
machines using the vault may still have the extension installed; `ext list` then reports it as
enabled but missing here.

Set `BRAIN_NO_EXTENSIONS=1` to disable discovery for a process. Built-in command names always
win and manifests cannot use one, so an extension can never replace `search`, `context`, or
another core command.

## Manifest

An extension directory has a `brain-extension.json` at its root:

```json
{
  "name": "example",
  "version": "1.0.0",
  "brain": ">=0.10 <1",
  "description": "Import summaries from Example",
  "command": "bin/brain-example",
  "permissions": {
    "read": ["Projects/"],
    "write": ["example"],
    "network": ["api.example.com"]
  }
}
```

- `name` is the command after `brain`; it uses lowercase letters, numbers, and dashes.
- `version` is a semantic version. `brain` and `description` are optional metadata.
- `command` is a relative path that must remain inside the installation and be executable.
- `permissions.read` lists vault folder prefixes; `"*"` means the whole vault.
- `permissions.write` lists log kinds the extension may add.
- `permissions.network` lists host names shown during approval.

Read and write permissions become a normal brain integration scope. A network declaration is
not a sandbox: extension code runs with the person's OS permissions, and brain cannot stop it
from opening another host or reading files directly. Scopes constrain what brain returns and
writes, not what arbitrary local code can access.

### Windows launchers

The manifest uses one extensionless command path, such as `bin/brain-example`. Unix runs that
file directly. On Windows, brain looks for `bin/brain-example.exe` first and then
`bin/brain-example.cmd`. Cross-platform extensions should ship the Unix executable plus one of
those Windows launchers. This keeps platform suffixes out of the manifest.

## Process contract

brain starts an enabled extension in its installation directory and forwards its command
arguments. It sets:

| Variable | Value |
| --- | --- |
| `BRAIN_VAULT` | real path of the current vault |
| `BRAIN_BIN` | the exact brain launcher that started the extension |
| `BRAIN_AS` | extension name, or the existing integration name when already scoped |
| `BRAIN_EXT_DIR` | this extension's installed directory |
| `BRAIN_MACHINE` | current machine name |

Extensions should call `BRAIN_BIN … --json` instead of reading the vault. Those child calls use
the manifest scope. If the original command was already under `BRAIN_AS`, brain uses the
intersection of that integration's scope and the extension's permissions – an extension can
narrow a caller but cannot widen it. Inputs an extension sends through `brain log add` are run
through core redaction before the new note is created.

The process must write exactly one JSON line to stdout using the existing envelope:

```json
{"schema":"brain.v1","command":"example.import","ok":true,"data":{"added":2}}
```

On failure it uses `ok: false`, an `error` object, and a non-zero exit. Diagnostics may go to
stderr. brain validates the envelope and exit code before forwarding it. Invalid output or a
crash fails only that extension command; built-ins and `brain context` continue normally.

## Reference: meetings

[`examples/meetings/`](../examples/meetings/) is a dependency-free reference extension:

```sh
brain ext install ./examples/meetings
BRAIN_MEETINGS_API_URL=http://127.0.0.1:3000/meetings \
  brain meetings import --since 7d
```

It records one `meeting` entry per source ID with the title, date, attendees, source-provided
summary, action items, and a link back to the source. It never stores a transcript. IDs are
stored only as hashes, making another import of the same window a no-op. Its automated tests use
a local fake source server – the repository contains no live account or external credential.
