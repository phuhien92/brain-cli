# Extensions

Extensions add commands and event hooks without loading third-party code into brain's process.
The local web interface remains design work in [`design/extensions.md`](design/extensions.md).

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
agents, scripts, CI, and hooks cannot silently grant permissions. Credentials embedded in a Git
URL are used only for cloning; install metadata, `ext list`, errors, and error diagnostics remove
URL user information, query strings, fragments, and SCP-style usernames.

Installed code is per machine (`~/.local/share/brain/extensions` by default, overridable with
`BRAIN_EXTENSIONS_DIR`). A Git install records its exact commit; a local install is a copy, not a
link to mutable source. Approval also creates an immutable enablement note at
`<log.dir>/extensions/<name>.md`. Those notes sync with the rest of the log, so work and
personal vaults can enable different commands without rewriting a shared configuration file.
`ext remove` removes only this machine's copy. It deliberately leaves the enablement note in
place because other machines using the vault may still have the extension installed; `ext list`
then reports it as enabled but missing here.

Built-in command names always win and manifests cannot use one, so an extension can never
replace `search`, `context`, or another core command.

## Manifest

An extension directory has a `brain-extension.json` at its root:

```json
{
  "name": "example",
  "version": "1.0.0",
  "brain": ">=0.10 <1",
  "description": "Import summaries from Example",
  "command": "bin/brain-example",
  "hooks": {
    "context.build": "bin/context-hook",
    "log.added": "bin/log-hook"
  },
  "permissions": {
    "read": ["Projects/"],
    "write": ["example"],
    "network": ["api.example.com"],
    "environment": ["EXAMPLE_API_TOKEN"]
  }
}
```

- `name` is the command after `brain`; it uses lowercase letters, numbers, and dashes.
- `version` is a semantic version. `brain` and `description` are optional metadata.
- `command` is a relative path that must remain inside the installation and be executable.
- `hooks` optionally maps `context.build` and `log.added` to separate executable paths inside
  the installation. Other event names are rejected.
- `permissions.read` lists vault folder prefixes; `"*"` means the whole vault.
- `permissions.write` lists log kinds the extension may add.
- `permissions.network` lists host names shown during approval.
- `permissions.environment` lists ambient variable names copied into the extension process;
  undeclared variables, including credentials, are not inherited.

Read and write permissions become a normal brain integration scope. A network declaration is
not a sandbox: extension code runs with the person's OS permissions, and brain cannot stop it
from opening another host or reading files directly. Scopes constrain what brain returns and
writes, not what arbitrary local code can access.

### Windows launchers

The manifest uses one extensionless command path, such as `bin/brain-example`. Unix runs that
file directly. On Windows, brain looks for `bin/brain-example.exe` first and then
`bin/brain-example.cmd`. Cross-platform extensions should ship the Unix executable plus one of
those Windows launchers. A `.cmd` launcher is invoked without command-line arguments; its program
reads the JSON string list in `BRAIN_EXTENSION_ARGS_JSON`. This keeps untrusted arguments out of
cmd syntax and platform suffixes out of the manifest.

## Process contract

brain starts an enabled extension in its installation directory and forwards its command
arguments. It sets:

| Variable | Value |
| --- | --- |
| `BRAIN_VAULT` | real path of the current vault |
| `BRAIN_BIN` | executable for invocation-specific scoped brain child calls |
| `BRAIN_BIN_ARGS_JSON` | JSON string list of arguments to prepend when invoking `BRAIN_BIN` |
| `BRAIN_AS` | extension name, or the existing integration name when already scoped |
| `BRAIN_EXT_DIR` | this extension's installed directory |
| `BRAIN_MACHINE` | current machine name |
| `BRAIN_EXT_REDACT_TOKEN` | opaque token for marking a sanitized extension-generated source URL |
| `BRAIN_EXTENSION_ARGS_JSON` | Windows `.cmd` launchers only: the command arguments as a JSON string list |

The process also receives a minimal runtime environment (`PATH`, home/temp, locale, terminal, and
required Windows process variables) plus values explicitly approved in `permissions.environment`.

Extensions should execute `BRAIN_BIN` with the arguments from `BRAIN_BIN_ARGS_JSON` followed by
the brain arguments and `--json`, instead of reading the vault. The executable is brain's current
Node runtime and the prefix selects the scoped runner without relying on `PATH`. Those child calls use
the manifest scope; the launcher restores its trusted scope and redaction context before dispatch.
If the original command was already under `BRAIN_AS`, brain uses the
intersection of that integration's scope and the extension's permissions – an extension can
narrow a caller but cannot widen it. Extension children may call only `search`, `get`, read-only
`log`, `log add`, `view`, and `lifecycle status` (plus `help` and `--version`); `log import`, `context`,
mutating lifecycle commands, machine administration,
configuration, diagnostics, sync/export, feedback, telemetry, unrestricted index/lint data,
path inspection, and other extensions are denied before dispatch. Inputs an extension sends through `brain log add` are run
through core redaction before the new note is created. To retain a sanitized HTTP(S) source URL,
remove credentials, query, and fragment, ensure its origin and decoded path contain no redacted values
and its path contains no nested percent escapes, encode its
canonical UTF-8 bytes as base64url, and place it inside
`<!-- brain-protected-url:<BRAIN_EXT_REDACT_TOKEN>:<encoded-url> -->`. Core reduces a URL with a sensitive
or malformed encoded path to its origin, omits a URL with a sensitive origin, and rejects other protected values.
Use `brain log add … --source-id <sha256> --source-created <canonical-ISO-timestamp>` for exact
create-only source deduplication. The timestamp preserves source chronology, while provenance is
the extension name (`source` for direct calls). The hash selects one machine-independent path: identical imports on separate
machines merge as the same file, while different content for one source ID produces a sync conflict
instead of a second source record.

The process must write exactly one non-empty JSON line to stdout using the existing envelope:

```json
{"schema":"brain.v1","command":"example.import","ok":true,"data":{"added":2}}
```

On failure it uses `ok: false`, an `error` object, and a non-zero exit. Diagnostics may go to
stderr. brain validates the envelope and exit code before forwarding it. A command's process tree is killed
after 30 seconds or after stdout and stderr together exceed 1 MiB. Invalid output, a crash, or either limit fails only that
extension command; built-ins and `brain context` continue normally.

## Hook contract

Each declared hook is another separate process, started in extension-name order with the same
working directory, scoped `BRAIN_BIN`, environment allowlist, and permissions as a command.
It reads one event from stdin and must write one success envelope to stdout:

```json
{"schema":"brain.hook.v1","event":"context.build","data":{}}
{"schema":"brain.hook.v1","event":"context.build","ok":true,"data":{"lines":["3 notes need review"]}}
```

The first line is an example input and the second is its output. Output must be exactly one
non-empty JSON line. A `log.added` success returns an object in `data` (normally `{}`). Hook
stdout and stderr together are limited to 64 KiB. Failures are appended to
`<brain path state>/hooks.log`; they never replace normal command output.

### `context.build`

This event's input `data` is empty: it does not hand vault content across the process boundary.
The hook may use its scoped `BRAIN_BIN` to derive a line from only its declared read folders and
log kinds, intersected with the caller's `BRAIN_AS` scope. Its output `data.lines` may contain up
to 20 non-empty, single-line strings of at most 1,000 characters each. brain preserves extension
and line order and inserts valid lines into the primer.

All `context.build` processes share a 300 ms execution budget. A timeout, crash, malformed
envelope, invalid lines, or broken installed extension is dropped. Healthy output and the core
primer still print, and `brain context` still exits 0.

### `log.added`

This event is dispatched only for a newly created entry, after its file has been created with
exclusive-write semantics and the index has refreshed. It is not emitted for an idempotent
`--source-id` entry that already existed. Input data has this shape:

```json
{"entry":{"path":"log/learning/…md","kind":"learning","title":"…","body":"…","tags":[],"machine":"laptop"}}
```

brain dispatches only when the entry path is readable under both the hook's declared permissions
and the caller's scope. A detached supervisor gives each hook 30 seconds; hook latency, malformed
output, or failure cannot change `log add`'s output or exit status. The entry is already durable
when the hook starts, so reactions must be idempotent if their own side effects may be retried.

Hooks run with the user's OS permissions – these payload and child-command checks are guardrails,
not a sandbox. `search.after`, `sync.after`, and `lint.run` are not implemented. A future
`search.after` will be enabled per call only, so ordinary search ranking stays explainable.

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

## Reference: bench

[`examples/bench/`](../examples/bench/) is a read-only extension: it declares `read: ["*"]`
and no writes, calls `brain search` and `brain get` through `BRAIN_BIN`, and runs grep and the
Obsidian CLI as an agent would. See [the benchmark](benchmark.md).
