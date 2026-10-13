import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig, slug, type Config } from "./config.js";
import { context, HARNESSES, install, type Harness } from "./agent.js";
import { addEntry, exportView, importFile, listEntries, renderView, type ExportResult } from "./log.js";
import { Store, type RefreshStats } from "./store.js";
import { sync, SyncError } from "./sync.js";

export const VERSION = "0.3.0";
// Bumped only on a breaking change to the --json envelope or a command's data shape.
export const SCHEMA = "brain.v1";

const HELP = `brain — headless memory for a markdown vault

USAGE
  brain <command> [args] [flags]

COMMANDS
  index [--rebuild]           Bring the index up to date (every command does this first)
  search <query>              Ranked full-text search over titles, aliases, headings, tags, body
      --limit <n>             Max results (default 10, max 100)
      --path <folder>         Only notes under this folder
      --tag <tag>             Only notes carrying this tag
      --raw                   Treat <query> as SQLite FTS5 syntax (AND, NEAR, prefix*)
  get <note>                  Print a note by path, file name, title or alias
      --meta                  Frontmatter, tags, headings and links only, no body

  log add <kind> <title>      Record an entry as a new file: <log>/<kind>/<date>-<machine>-<slug>.md
      --body <text|->         Entry body (- reads stdin)
      --tag <tag>             Tag the entry (repeatable)
  log [n] [--kind <kind>]     Show the n most recent entries (default 10)
  log import <kind> <file>    Turn an existing memory file into entries, one per list item;
                              titles already recorded are skipped
  view <kind>                 Print every <kind> entry as one markdown list, oldest first
  export [--force]            Write each configured view to its path as a regular file;
                              refuses (exit 5) if the file was edited since brain wrote it
  sync [--no-push]            Commit new entries, pull --rebase, push, then export

  context [--limit n]         Print a short primer for an agent: what brain is, plus the n most
                              recent memory titles. Prints nothing (exit 0) without a vault,
                              so it is safe in a session-start hook
  agent install <harness>     Teach an agent harness about brain: claude | pi | agents
      --dry-run               Show what would be written
      --force                 Replace an existing file brain did not write

  help                        Show this help

GLOBAL FLAGS
  --vault <dir>               Vault root (default: $BRAIN_VAULT, else the nearest
                              parent folder holding .obsidian/ or .brain/)
  --json                      Emit a versioned machine-readable envelope
  --quiet, -q                 Suppress successful human-readable output
  --version                   Print the version

CONFIG
  <vault>/brain.json          Synced with the vault: { "log": { "dir": "log" } }
  $BRAIN_CONFIG               This machine only (default ~/.config/brain/config.json):
                              { "machine": "mac-mini",
                                "exports": [{ "kind": "learning", "path": "~/fm/data/learnings.md" }] }
  $BRAIN_MACHINE              Overrides the machine name (default: hostname)

EXIT CODES
  0 ok · 1 error · 2 usage · 3 note not found · 4 ambiguous note reference
  5 conflict: sync hit notes edited on two machines, or export found unrecorded edits
`;

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exit: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface Out {
  json: boolean;
  quiet: boolean;
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        vault: { type: "string" },
        json: { type: "boolean", default: false },
        quiet: { type: "boolean", short: "q", default: false },
        version: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        rebuild: { type: "boolean", default: false },
        limit: { type: "string" },
        path: { type: "string" },
        raw: { type: "boolean", default: false },
        meta: { type: "boolean", default: false },
        body: { type: "string" },
        tag: { type: "string", multiple: true },
        kind: { type: "string" },
        force: { type: "boolean", default: false },
        "no-push": { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
      },
    });
  } catch (err) {
    const json = argv.includes("--json");
    return fail({ json, quiet: false }, "unknown", new CliError("usage", (err as Error).message, 2));
  }

  const { values: flags, positionals } = parsed;
  const out: Out = { json: flags.json ?? false, quiet: flags.quiet ?? false };
  const [command = "help", ...args] = positionals;

  if (flags.version) {
    print(out, "version", { version: VERSION }, null, () => VERSION);
    return 0;
  }
  if (flags.help || command === "help") {
    if (out.json) print(out, "help", { usage: HELP }, null, () => "");
    else process.stdout.write(HELP);
    return 0;
  }

  if (command === "agent") {
    try {
      const [sub, harness = ""] = args;
      if (sub !== "install" || !(HARNESSES as readonly string[]).includes(harness)) {
        throw new CliError("usage", `usage: brain agent install <${HARNESSES.join("|")}> [--dry-run] [--force]`, 2);
      }
      const result = install(harness as Harness, { force: flags.force, dryRun: flags["dry-run"] });
      const conflicts = result.files.filter((f) => f.status === "conflict");
      if (conflicts.length) {
        throw new CliError(
          "install_conflict",
          `${conflicts.map((f) => f.path).join(", ")} exists and was not written by brain; rerun with --force to replace it`,
          5,
          { files: conflicts.map((f) => f.path) },
        );
      }
      print(out, "agent.install", { ...result, dryRun: flags["dry-run"] }, null, () =>
        [
          ...result.files.map((f) => `${flags["dry-run"] && f.status === "written" ? "would write" : f.status}  ${f.path}`),
          ...result.warnings.map((w) => `warning: ${w}`),
          ...(result.next.length ? ["", ...result.next] : []),
        ].join("\n"),
      );
      return 0;
    } catch (err) {
      return fail(out, "agent.install", err);
    }
  }

  if (command === "context") {
    // Runs inside other tools' session-start hooks: any failure prints nothing
    // and exits 0, so a missing vault never breaks the agent that called it.
    let ctxStore: Store | null = null;
    try {
      const limit = flags.limit === undefined ? 5 : Math.max(0, Math.min(Number(flags.limit) || 0, 50));
      const vault = findVault(flags.vault);
      const cfg = loadConfig(vault);
      ctxStore = Store.open(vault);
      const index = ctxStore.refresh();
      const text = context(ctxStore, cfg, limit);
      print(out, "context", { context: text }, { vault, index }, () => text);
    } catch {
      if (out.json) print(out, "context", { context: "" }, null, () => "");
    } finally {
      ctxStore?.close();
    }
    return 0;
  }

  let store: Store | null = null;
  try {
    if (!["index", "search", "get", "log", "view", "export", "sync"].includes(command)) {
      throw new CliError("usage", `unknown command '${command}' — run 'brain help'`, 2);
    }
    const vault = findVault(flags.vault);
    const cfg = loadConfig(vault);
    store = Store.open(vault, { rebuild: command === "index" && flags.rebuild });
    let index = store.refresh();

    switch (command) {
      case "index": {
        const data = { notes: store.count(), ...index };
        print(out, command, data, { vault, index }, () =>
          `${vault}\n${data.notes} notes · +${index.added} ~${index.updated} -${index.removed} · ${index.ms}ms`,
        );
        return 0;
      }

      case "search": {
        const query = args.join(" ").trim();
        if (!query) throw new CliError("usage", "search needs a query: brain search <query>", 2);
        const limit = flags.limit === undefined ? 10 : Number(flags.limit);
        if (!Number.isInteger(limit) || limit < 1) throw new CliError("usage", "--limit must be a positive integer", 2);
        let hits;
        try {
          hits = store.search(query, { limit, path: flags.path, tag: flags.tag?.[0], raw: flags.raw });
        } catch (err) {
          if (flags.raw) throw new CliError("bad_query", `invalid FTS5 query: ${(err as Error).message}`, 2);
          throw err;
        }
        print(out, command, { query, results: hits }, { vault, index }, () =>
          hits.length
            ? hits
                .map((h, i) => `${i + 1}. ${h.path}  (${h.score})\n   ${h.title !== stem(h.path) ? h.title + " — " : ""}${h.snippet}`)
                .join("\n")
            : `no results for '${query}'`,
        );
        return 0;
      }

      case "get": {
        const ref = args.join(" ").trim();
        if (!ref) throw new CliError("usage", "get needs a note: brain get <path|name|title>", 2);
        const matches = store.resolve(ref);
        if (matches.length === 0) throw new CliError("not_found", `no note matches '${ref}'`, 3);
        if (matches.length > 1) {
          throw new CliError("ambiguous", `'${ref}' matches ${matches.length} notes — use a path`, 4, {
            candidates: matches,
          });
        }
        const note = store.get(matches[0]!)!;
        const data = flags.meta ? { ...note, content: undefined } : note;
        print(out, command, data, { vault, index }, () => (flags.meta ? formatMeta(note) : note.content));
        return 0;
      }

      case "log": {
        const [sub, ...rest] = args;
        if (sub === "add") {
          const [kind = "", ...titleWords] = rest;
          const title = titleWords.join(" ").trim();
          if (!slug(kind) || !title) throw new CliError("usage", 'usage: brain log add <kind> <title> [--body <text|->] [--tag t]', 2);
          const body = flags.body === "-" ? readFileSync(0, "utf8") : flags.body;
          const path = addEntry(vault, cfg, { kind, title, body, tags: flags.tag });
          index = store.refresh();
          print(out, "log.add", { path, kind: slug(kind), machine: cfg.machine }, { vault, index }, () => path);
          return 0;
        }
        if (sub === "import") {
          const [kind = "", file = ""] = rest;
          if (!slug(kind) || !file) throw new CliError("usage", "usage: brain log import <kind> <file>", 2);
          const abs = resolve(file);
          if (!existsSync(abs)) throw new CliError("not_found", `no file at ${abs}`, 3);
          const result = importFile(store, cfg, kind, abs);
          index = store.refresh();
          print(out, "log.import", { file: abs, kind: slug(kind), ...result }, { vault, index }, () =>
            `imported ${result.added.length} ${slug(kind)} entries from ${abs}` +
            (result.skipped ? ` (${result.skipped} already recorded)` : ""),
          );
          return 0;
        }
        const n = sub === undefined ? 10 : Number(sub);
        if (!Number.isInteger(n) || n < 1 || rest.length) {
          throw new CliError("usage", "usage: brain log [n] [--kind k] | log add <kind> <title> | log import <kind> <file>", 2);
        }
        const entries = listEntries(store, cfg, { kind: flags.kind ? slug(flags.kind) : undefined, limit: n });
        print(out, "log", { entries }, { vault, index }, () =>
          entries.length
            ? entries.map((e) => `${e.created.slice(0, 10)}  ${e.kind.padEnd(10)} ${e.machine.padEnd(12)} ${e.title}`).join("\n")
            : "no entries yet — add one with: brain log add <kind> <title>",
        );
        return 0;
      }

      case "view": {
        const kind = slug(args[0] ?? "");
        if (!kind) throw new CliError("usage", "usage: brain view <kind>", 2);
        const entries = listEntries(store, cfg, { kind });
        const markdown = renderView(entries);
        print(out, command, { kind, entries: entries.length, markdown }, { vault, index }, () => markdown);
        return 0;
      }

      case "export": {
        const exports = runExports(store, cfg, flags.force);
        const drift = exports.filter((e) => e.status === "drift");
        if (drift.length) {
          if (!out.json && !out.quiet) process.stdout.write(formatExports(exports) + "\n");
          throw new CliError("export_drift", driftMessage(drift), 5, { exports });
        }
        print(out, command, { exports }, { vault, index }, () => formatExports(exports) || "no exports configured");
        return 0;
      }

      case "sync": {
        const result = sync(vault, cfg, { push: !flags["no-push"] });
        index = store.refresh();
        const exports = runExports(store, cfg, false);
        print(out, command, { ...result, machine: cfg.machine, exports }, { vault, index }, () =>
          [
            `${cfg.machine}: committed ${result.committed} · pulled ${result.pulled} · ` +
              (result.remote ? (result.pushed ? "pushed" : "nothing to push") : "no upstream — local commit only"),
            formatExports(exports),
          ]
            .filter(Boolean)
            .join("\n"),
        );
        // The sync itself succeeded; unrecorded edits to an export are surfaced
        // in data.exports and on stderr rather than failing the whole sync.
        const drift = exports.filter((e) => e.status === "drift");
        if (drift.length && !out.json) process.stderr.write(`brain: ${driftMessage(drift)}\n`);
        return 0;
      }
    }
    return 0;
  } catch (err) {
    return fail(out, command, err);
  } finally {
    store?.close();
  }
}

function runExports(store: Store, cfg: Config, force: boolean): ExportResult[] {
  return cfg.exports.map((t) => exportView(store, cfg, t, force));
}

function formatExports(exports: ExportResult[]): string {
  return exports.map((e) => `export ${e.kind} → ${e.path}: ${e.status} (${e.entries} entries)`).join("\n");
}

function driftMessage(drift: ExportResult[]): string {
  return (
    `${drift.map((d) => d.path).join(", ")} changed since brain last wrote it. ` +
    `Capture those edits first (brain log import <kind> <file>), then run brain export --force.`
  );
}

// Always the real path: on macOS /var is a symlink to /private/var, and a vault
// found via the shell's cwd and one named in $BRAIN_VAULT must not be reported as
// two different vaults.
function findVault(flag: string | undefined): string {
  return realpathSync(locateVault(flag));
}

function locateVault(flag: string | undefined): string {
  const explicit = flag ?? process.env.BRAIN_VAULT;
  if (explicit) {
    const dir = resolve(explicit);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new CliError("no_vault", `vault '${dir}' is not a directory`, 1);
    }
    return dir;
  }
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, ".obsidian")) || existsSync(join(dir, ".brain"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CliError(
    "no_vault",
    "no vault found: pass --vault <dir>, set BRAIN_VAULT, or run inside a folder with .obsidian/ or .brain/",
    1,
  );
}

function print(
  out: Out,
  command: string,
  data: unknown,
  ctx: { vault: string; index: RefreshStats } | null,
  human: () => string,
): void {
  if (out.json) {
    const envelope = { schema: SCHEMA, command, ok: true, ...(ctx ?? {}), data };
    process.stdout.write(JSON.stringify(envelope) + "\n");
  } else if (!out.quiet) {
    const text = human();
    if (text) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  }
}

function fail(out: Out, command: string, err: unknown): number {
  const e =
    err instanceof CliError
      ? err
      : err instanceof SyncError
        ? new CliError(err.code, err.message, err.code === "sync_conflict" ? 5 : 1, err.files.length ? { files: err.files } : undefined)
        : err instanceof ConfigError
          ? new CliError("config", err.message, 1)
          : new CliError("internal", err instanceof Error ? err.message : String(err), 1);
  if (out.json) {
    const envelope = {
      schema: SCHEMA,
      command,
      ok: false,
      error: { code: e.code, message: e.message, ...(e.details ?? {}) },
    };
    process.stdout.write(JSON.stringify(envelope) + "\n");
  } else {
    process.stderr.write(`brain: ${e.message}\n`);
    for (const key of ["candidates", "files"]) {
      const list = e.details?.[key];
      if (Array.isArray(list)) for (const c of list) process.stderr.write(`  ${c}\n`);
    }
  }
  return e.exit;
}

function formatMeta(note: NonNullable<ReturnType<Store["get"]>>): string {
  const lines = [`${note.path}`, `title: ${note.title}`];
  if (note.aliases.length) lines.push(`aliases: ${note.aliases.join(", ")}`);
  if (note.tags.length) lines.push(`tags: ${note.tags.join(", ")}`);
  for (const [k, v] of Object.entries(note.frontmatter)) {
    if (["title", "tags", "aliases", "alias"].includes(k)) continue;
    lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  }
  if (note.headings.length) lines.push("headings:", ...note.headings.map((h) => `  ${h}`));
  if (note.links.length) {
    lines.push("links:", ...note.links.map((l) => `  [[${l.target}${l.heading ? "#" + l.heading : ""}]]`));
  }
  return lines.join("\n");
}

function stem(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}
