import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ConfigError, inScope, loadConfig, readScope, slug, userSettings, type Config } from "./config.js";
import {
  createDraft,
  diagnostics,
  getDraft,
  issueUrl,
  KINDS,
  lastError,
  listDrafts,
  markSubmitted,
  postWithGh,
  redactor,
  repo,
  saveLastError,
  type Kind,
} from "./feedback.js";
import * as telemetry from "./telemetry.js";
import { context, HARNESSES, install, type Harness } from "./agent.js";
import { CATEGORIES, isDate, LIFECYCLE_KIND, lifecycleStates, recordLifecycle, today, windows, type Category, type LifecycleState } from "./lifecycle.js";
import { lint } from "./lint.js";
import { addEntry, exportView, importFile, listEntries, renderView, type ExportResult } from "./log.js";
import { indexDir, OfflineNoteError, Store, type RefreshStats } from "./store.js";
import { isGitRepo, resolveSyncMode, sync, SyncError } from "./sync.js";

export const VERSION = "0.8.1";
// Bumped only on a breaking change to the --json envelope or a command's data shape.
export const SCHEMA = "brain.v1";

const HELP = `brain — headless memory for a markdown vault

USAGE
  brain <command> [args] [flags]

COMMANDS
  index [--rebuild|--verify]  Bring the index up to date (every command does this first);
                              --verify re-reads and hashes every note instead of trusting
                              modification time and size; --rebuild starts from scratch
  search <query>              Ranked full-text search over titles, aliases, headings, tags, body
      --limit <n>             Max results (default 10, max 100)
      --path <folder>         Only notes under this folder
      --tag <tag>             Only notes carrying this tag
      --raw                   Treat <query> as SQLite FTS5 syntax (AND, NEAR, prefix*)
      --include-archived      Also return archived notes
  get <note>                  Print a note by path, file name, title or alias
      --meta                  Frontmatter, tags, headings and links only, no body
      --section <heading>     Only that section: the heading and everything under it,
                              up to the next heading of the same or higher level
                              (repeatable; matched case-insensitively, by prefix)
      --lines <n>             Only the first n lines of each section (or of the note) —
                              enough for a newest-first log

  log add <kind> <title>      Record an entry as a new file: <log>/<kind>/<date>-<machine>-<slug>.md
      --body <text|->         Entry body (- reads stdin)
      --tag <tag>             Tag the entry (repeatable)
  log [n] [--kind <kind>]     Show the n most recent entries (default 10)
  log import <kind> <file>    Turn an existing memory file into entries, one per list item;
                              titles already recorded are skipped
  view <kind>                 Print every <kind> entry as one markdown list, oldest first
  export [--force]            Write each configured view to its path as a regular file;
                              refuses (exit 5) if the file was edited since brain wrote it
  sync [--no-push]            Bring other machines' changes in and send ours out, by the
                              vault's sync mode (brain.json "sync"): git commits the log,
                              pulls and pushes; none leaves it to iCloud/Dropbox/etc.;
                              { "command": … } runs yours. Then refreshes and exports

  lifecycle set <note> --category <c> [--as-of YYYY-MM-DD]
                              Classify how a note's truth changes over time:
                              memory, identity, preference, principle (enduring);
                              research 180d, current-state 30d, news 14d (time-bound)
  lifecycle review <note> [--on YYYY-MM-DD] [--as-of YYYY-MM-DD]
                              Confirm a time-bound note against current evidence
  lifecycle archive <note> --reason "..."
                              Hide an obsolete or misplaced note from search and recall
  lifecycle restore <note>    Undo an archive
  lifecycle status [--due]    Every note with lifecycle data; --due: only overdue ones
  lint [--strict]             Report broken links, orphans, sync conflict copies, overdue
                              reviews, lifecycle problems and line limits (--strict: exit 7
                              if anything is reported at warn level)

  integrations                List the repos/tools connected to this vault, what each may
                              read and write, and their view paths on this machine
  doctor                      Check this machine's setup: vault, index location, sync
                              mode, iCloud placeholders, git inside a synced folder

  context [--limit n]         Print a short primer for an agent: what brain is, plus the n most
                              recent memory titles. Prints nothing (exit 0) without a vault,
                              so it is safe in a session-start hook
  agent install <harness>     Teach an agent harness about brain: claude | pi | agents
      --dry-run               Show what would be written
      --force                 Replace an existing file brain did not write

  feedback "<what happened>"  Draft a bug report, idea or docs fix for brain, redacted on this
      --kind bug|idea|docs    machine (vault path, note paths and titles, emails, numbers)
      --from-last-error       Include the last command that failed here
  feedback list|show <id>     Your drafts
  feedback submit <id>        Print a pre-filled GitHub issue link for a person to submit;
      --post                  post with the gh CLI instead — only with the user's permission:
                              --user-approved, or "feedback": { "post": "allow" } in config
  telemetry [status|show|enable|disable|reset]
                              Anonymous usage data — off unless you opt in (brain asks once,
                              in a terminal); show prints exactly what is queued

  help                        Show this help

GLOBAL FLAGS
  --vault <dir>               Vault root (default: $BRAIN_VAULT, else the nearest
                              parent folder holding .obsidian/ or brain.json)
  --as <integration>          Act as a configured integration ($BRAIN_AS): search, get and
                              log see only its folders; log add only its kinds
  --json                      Emit a versioned machine-readable envelope
  --quiet, -q                 Suppress successful human-readable output
  --version                   Print the version

CONFIG
  <vault>/brain.json          Synced with the vault: { "log": { "dir": "log" } }
  $BRAIN_CONFIG               This machine only (default ~/.config/brain/config.json):
                              { "machine": "mac-mini",
                                "exports": [{ "kind": "learning", "path": "~/fm/data/learnings.md" }] }
  $BRAIN_MACHINE              Overrides the machine name (default: hostname)
  $BRAIN_STATE_DIR            Where indexes live (default ~/.local/state/brain); never
                              inside the vault, so iCloud/Dropbox never sync a live database

EXIT CODES
  0 ok · 1 error · 2 usage · 3 note not found · 4 ambiguous note reference
  5 conflict: sync hit notes edited on two machines, or export found unrecorded edits
  6 not permitted: outside the acting integration's scope · 7 lint --strict found warnings
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

// Telemetry records a command by a name from these lists only. Anything else
// a user typed (a query, a note, feedback text) can never become a name.
const COMMANDS = ["index", "search", "get", "log", "view", "export", "sync", "integrations", "doctor", "lifecycle", "lint", "context", "agent", "feedback", "telemetry", "help"];
const SUBCOMMANDS: Record<string, string[]> = {
  log: ["add", "import"],
  lifecycle: ["set", "review", "archive", "restore", "status"],
  agent: ["install"],
  feedback: ["list", "show", "submit", "add"],
  telemetry: ["status", "show", "enable", "disable", "reset", "flush"],
};

export function telemetryName(command: string, sub: string | undefined): string {
  if (!COMMANDS.includes(command)) return "unknown";
  return sub && SUBCOMMANDS[command]?.includes(sub) ? `${command}.${sub}` : command;
}

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "brain.js");

// Filled in while a command runs, read once it finishes, for telemetry.
let tCommand = "unknown";
let tError: string | null = null;
let tContext: telemetry.Context = {};

export async function main(argv: string[]): Promise<number> {
  const started = Date.now();
  tCommand = "unknown";
  tError = null;
  tContext = {};
  const json = argv.includes("--json");
  const first = argv.find((a) => !a.startsWith("-"));
  const after = first ? argv[argv.indexOf(first) + 1] : undefined;
  if (telemetry.shouldAsk({ json, command: telemetryName(first ?? "help", after), userConfigTelemetry: userSettings().telemetry })) {
    try {
      await telemetry.ask();
    } catch {
      // a broken terminal never blocks the command
    }
  }
  const exit = await run(argv);
  // Managing telemetry is not usage of brain; it is never itself recorded.
  if (!tCommand.startsWith("telemetry")) {
    telemetry.record(
      { command: tCommand, exit, error: tError, ms: Date.now() - started, json: argv.includes("--json"), version: VERSION },
      tContext,
      userSettings().telemetry,
      BIN,
    );
  }
  return exit;
}

async function run(argv: string[]): Promise<number> {
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
        verify: { type: "boolean", default: false },
        limit: { type: "string" },
        path: { type: "string" },
        raw: { type: "boolean", default: false },
        meta: { type: "boolean", default: false },
        section: { type: "string", multiple: true },
        lines: { type: "string" },
        body: { type: "string" },
        tag: { type: "string", multiple: true },
        kind: { type: "string" },
        force: { type: "boolean", default: false },
        "no-push": { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        as: { type: "string" },
        category: { type: "string" },
        "as-of": { type: "string" },
        on: { type: "string" },
        reason: { type: "string" },
        due: { type: "boolean", default: false },
        strict: { type: "boolean", default: false },
        "include-archived": { type: "boolean", default: false },
        title: { type: "string" },
        "from-last-error": { type: "boolean", default: false },
        post: { type: "boolean", default: false },
        "user-approved": { type: "boolean", default: false },
      },
    });
  } catch (err) {
    const json = argv.includes("--json");
    return fail({ json, quiet: false }, "unknown", new CliError("usage", (err as Error).message, 2));
  }

  const { values: flags, positionals } = parsed;
  const out: Out = { json: flags.json ?? false, quiet: flags.quiet ?? false };
  const [command = "help", ...args] = positionals;
  tCommand = telemetryName(command, args[0]);

  if (flags.version) {
    print(out, "version", { version: VERSION }, null, () => VERSION);
    return 0;
  }
  if (flags.help || command === "help") {
    if (out.json) print(out, "help", { usage: HELP }, null, () => "");
    else process.stdout.write(HELP);
    return 0;
  }

  if (command === "telemetry") {
    try {
      const [sub = "status"] = args;
      const settings = userSettings();
      if (sub === "flush") {
        const r = await telemetry.flush();
        print(out, "telemetry.flush", r, null, () => (r.error ? `not sent: ${r.error}` : `sent ${r.sent} event(s)`));
        return 0;
      }
      if (sub === "enable" || sub === "disable") telemetry.setEnabled(sub === "enable");
      if (sub === "reset") telemetry.resetInstallId();
      if (!["status", "show", "enable", "disable", "reset"].includes(sub)) {
        throw new CliError("usage", "usage: brain telemetry [status|show|enable|disable|reset]", 2);
      }
      const st = telemetry.status(settings.telemetry);
      if (sub === "show") {
        const events = telemetry.queue();
        print(out, "telemetry.show", { ...st, events }, null, () =>
          events.length ? events.map((e) => JSON.stringify(e)).join("\n") : "no events queued",
        );
        return 0;
      }
      print(out, `telemetry.${sub}`, st, null, () =>
        [
          `telemetry: ${st.enabled ? "on" : "off"} (${st.reason})`,
          `collector: ${st.collector ?? "not configured — events stay on this machine"}`,
          `queued: ${st.queued} event(s) · install id: ${st.install}`,
          "what is collected: docs/telemetry.md · see it: brain telemetry show · stop: brain telemetry disable",
        ].join("\n"),
      );
      return 0;
    } catch (err) {
      return fail(out, tCommand, err);
    }
  }

  if (command === "feedback") {
    try {
      return await feedbackCommand(args, flags, out);
    } catch (err) {
      return fail(out, tCommand, err);
    }
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
      const cfg = loadConfig(vault, { as: flags.as });
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
    if (!["index", "search", "get", "log", "view", "export", "sync", "integrations", "doctor", "lifecycle", "lint"].includes(command)) {
      throw new CliError("usage", `unknown command '${command}' — run 'brain help'`, 2);
    }
    const vault = findVault(flags.vault);
    const cfg = loadConfig(vault, { as: flags.as });
    const scope = readScope(cfg);
    const permit = (ok: boolean, what: string) => {
      if (!ok) throw new CliError("not_permitted", `integration '${cfg.as!.name}' may not ${what}`, 6);
    };
    store = Store.open(vault, { rebuild: command === "index" && flags.rebuild });
    let index = store.refresh({ verify: command === "index" && flags.verify });
    tContext = {
      notes: store.count(),
      sync: typeof cfg.sync === "object" ? "command" : cfg.sync,
      integrations: Object.keys(cfg.integrations).length,
      scoped: !!cfg.as,
    };

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
          const states = lifecycleStates(store, cfg);
          const hidden = [...states.values()].filter((st) => st.archived && !flags["include-archived"]).map((st) => st.path);
          hits = store
            .search(query, { limit, path: flags.path, tag: flags.tag?.[0], raw: flags.raw, scope, exclude: hidden, excludePrefix: `${cfg.logDir}/${LIFECYCLE_KIND}/` })
            .map((h) => ({ ...h, lifecycle: brief(states.get(h.path)) }));
        } catch (err) {
          if (flags.raw) throw new CliError("bad_query", `invalid FTS5 query: ${(err as Error).message}`, 2);
          throw err;
        }
        print(out, command, { query, results: hits }, { vault, index }, () =>
          hits.length
            ? hits
                .map((h, i) => `${i + 1}. ${h.path}  (${h.score})${staleMark(h)}\n   ${h.title !== stem(h.path) ? h.title + " — " : ""}${h.snippet}`)
                .join("\n")
            : `no results for '${query}'`,
        );
        return 0;
      }

      case "get": {
        const ref = args.join(" ").trim();
        if (!ref) throw new CliError("usage", "get needs a note: brain get <path|name|title>", 2);
        // Out-of-scope notes are reported as not found, not as forbidden:
        // a restricted caller should not learn what else the vault holds.
        const matches = store.resolve(ref).filter((p) => inScope(p, scope));
        if (matches.length === 0) throw new CliError("not_found", `no note matches '${ref}'`, 3);
        if (matches.length > 1) {
          throw new CliError("ambiguous", `'${ref}' matches ${matches.length} notes — use a path`, 4, {
            candidates: matches,
          });
        }
        const note = { ...store.get(matches[0]!)!, lifecycle: brief(lifecycleStates(store, cfg).get(matches[0]!)) };
        const maxLines = flags.lines === undefined ? undefined : Number(flags.lines);
        if (maxLines !== undefined && (!Number.isInteger(maxLines) || maxLines < 1)) {
          throw new CliError("usage", "--lines must be a positive integer", 2);
        }
        if (maxLines !== undefined && !flags.section?.length) {
          const all = note.content.split("\n");
          const content = all.slice(0, maxLines).join("\n") + "\n";
          const truncated = all.length > maxLines;
          print(out, command, { ...note, content, truncated }, { vault, index }, () => content);
          return 0;
        }
        if (flags.section?.length) {
          const { content, found, missing } = extractSections(note.content, flags.section, maxLines);
          if (!found.length) {
            throw new CliError("not_found", `no section in ${note.path} matches ${flags.section.map((x) => `'${x}'`).join(", ")}`, 3, {
              headings: note.headings,
            });
          }
          const data = { ...note, content, sections: found, missing };
          print(out, command, data, { vault, index }, () =>
            content + (missing.length ? `\n(no section matched: ${missing.join(", ")})` : ""),
          );
          return 0;
        }
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
          if (cfg.as) permit(cfg.as.write.includes(slug(kind)), `add '${slug(kind)}' entries (it may write: ${cfg.as.write.join(", ") || "nothing"})`);
          const body = flags.body === "-" ? readFileSync(0, "utf8") : flags.body;
          const path = addEntry(vault, cfg, { kind, title, body, tags: flags.tag });
          index = store.refresh();
          print(out, "log.add", { path, kind: slug(kind), machine: cfg.machine }, { vault, index }, () => path);
          return 0;
        }
        if (sub === "import") {
          const [kind = "", file = ""] = rest;
          if (!slug(kind) || !file) throw new CliError("usage", "usage: brain log import <kind> <file>", 2);
          if (cfg.as) permit(cfg.as.write.includes(slug(kind)), `import '${slug(kind)}' entries`);
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
        const entries = listEntries(store, cfg, { kind: flags.kind ? slug(flags.kind) : undefined, limit: scope ? -1 : n })
          .filter((e) => inScope(e.path, scope))
          .slice(0, n);
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
        if (cfg.as) permit(inScope(`${cfg.logDir}/${kind}/`, scope), `read '${kind}' entries`);
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
            result.mode === "none"
              ? `${cfg.machine}: sync mode "none" — files are moved by your sync service; index refreshed`
              : result.mode === "command"
                ? `${cfg.machine}: ran the configured sync command`
                : `${cfg.machine}: committed ${result.committed} · pulled ${result.pulled} · ` +
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

      case "lifecycle": {
        const [sub, ...rest] = args;
        const states = lifecycleStates(store, cfg);
        if (sub === "status") {
          if (rest.length) throw new CliError("usage", "usage: brain lifecycle status [--due]", 2);
          const list = [...states.values()]
            .filter((st) => inScope(st.path, scope))
            .filter((st) => !flags.due || st.overdue)
            .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.path.localeCompare(b.path));
          print(out, "lifecycle.status", { today: today(), notes: list }, { vault, index }, () =>
            list.length
              ? list
                  .map((st) =>
                    `${st.overdue ? "OVERDUE " : st.archived ? "archived" : "        "} ${(st.category ?? "-").padEnd(13)} due ${st.due ?? "-         "}  ${st.path}` +
                    (st.problems.length ? `\n         ! ${st.problems.join("; ")}` : ""),
                  )
                  .join("\n")
              : flags.due
                ? "nothing is overdue"
                : "no notes have lifecycle data yet — start with: brain lifecycle set <note> --category <category>",
          );
          return 0;
        }
        if (!["set", "review", "archive", "restore"].includes(sub ?? "")) {
          throw new CliError("usage", "usage: brain lifecycle set|review|archive|restore <note> … | lifecycle status [--due]", 2);
        }
        const ref = rest.join(" ").trim();
        if (!ref) throw new CliError("usage", `usage: brain lifecycle ${sub} <note>`, 2);
        const matches = store.resolve(ref).filter((p) => inScope(p, scope));
        if (matches.length === 0) throw new CliError("not_found", `no note matches '${ref}'`, 3);
        if (matches.length > 1) {
          throw new CliError("ambiguous", `'${ref}' matches ${matches.length} notes — use a path`, 4, { candidates: matches });
        }
        const target = matches[0]!;
        if (cfg.as) permit(cfg.as.write.includes(LIFECYCLE_KIND), `record lifecycle changes (add "${LIFECYCLE_KIND}" to its write kinds)`);
        const date = (flag: string, v: string | undefined) => {
          if (v !== undefined && !isDate(v)) throw new CliError("usage", `--${flag} must be a YYYY-MM-DD date`, 2);
          return v;
        };
        let change;
        if (sub === "set") {
          const category = flags.category;
          if (!category || !(CATEGORIES as readonly string[]).includes(category)) {
            throw new CliError("usage", `--category must be one of: ${CATEGORIES.join(", ")}`, 2);
          }
          const asOf = date("as-of", flags["as-of"]);
          const w = windows(cfg)[category as Category];
          if (w !== null && !asOf && !states.get(target)?.asOf) {
            throw new CliError("usage", `${category} is time-bound: give --as-of YYYY-MM-DD (when the note was true)`, 2);
          }
          change = { action: "set" as const, category: category as Category, asOf };
        } else if (sub === "review") {
          change = { action: "review" as const, on: date("on", flags.on) ?? today(), asOf: date("as-of", flags["as-of"]) };
        } else if (sub === "archive") {
          if (!flags.reason?.trim()) throw new CliError("usage", 'archive needs --reason "..." (why it is no longer active)', 2);
          change = { action: "archive" as const, reason: flags.reason.trim().replace(/\s+/g, " ") };
        } else {
          change = { action: "restore" as const };
        }
        const entry = recordLifecycle(vault, cfg, target, change);
        index = store.refresh();
        const st = lifecycleStates(store, cfg).get(target)!;
        print(out, `lifecycle.${sub}`, { entry, state: st }, { vault, index }, () =>
          `${target}: ${st.archived ? "archived" : st.category ?? "no category"}${st.due ? `, next review ${st.due}` : ""}  (${entry})`,
        );
        return 0;
      }

      case "lint": {
        const findings = lint(store, cfg);
        const counts = { warn: findings.filter((f) => f.severity === "warn").length, info: findings.filter((f) => f.severity === "info").length };
        if (flags.strict && counts.warn) {
          if (!out.json && !out.quiet) process.stdout.write(formatFindings(findings) + "\n");
          throw new CliError("lint_failed", `${counts.warn} warning(s)`, 7, { findings, counts });
        }
        print(out, command, { findings, counts }, { vault, index }, () => (findings.length ? formatFindings(findings) : "no findings"));
        return 0;
      }

      case "integrations": {
        const list = Object.values(cfg.integrations).map((i) => ({
          name: i.name,
          read: i.read ?? ["*"],
          write: i.write,
          views: i.views.map((v) => ({ kind: v.kind, path: v.path })),
          acting: cfg.as?.name === i.name,
        }));
        print(out, command, { integrations: list, as: cfg.as?.name ?? null }, { vault, index }, () =>
          list.length
            ? list
                .map((i) =>
                  [
                    `${i.acting ? "* " : ""}${i.name}`,
                    `    read:  ${i.read.join(", ") || "(only its own log)"}`,
                    `    write: ${i.write.join(", ") || "(nothing)"}`,
                    ...(i.views.length ? i.views.map((v) => `    view:  ${v.kind} → ${v.path}`) : ["    view:  (none on this machine)"]),
                  ].join("\n"),
                )
                .join("\n")
            : 'no integrations yet — declare one under "integrations" in brain.json (see docs/integrations.md)',
        );
        return 0;
      }

      case "doctor": {
        const checks = doctor(vault, cfg, index, store.count());
        print(out, command, { checks }, { vault, index }, () =>
          checks.map((c) => `${c.status === "ok" ? "ok  " : "WARN"}  ${c.check}: ${c.detail}`).join("\n"),
        );
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

async function feedbackCommand(
  args: string[],
  flags: Record<string, unknown>,
  out: Out,
): Promise<number> {
  const [sub, ...rest] = args;

  if (sub === "list") {
    const drafts = listDrafts();
    print(out, "feedback.list", { drafts }, null, () =>
      drafts.length
        ? drafts.map((d) => `${d.id}  ${d.status.padEnd(9)} ${d.kind.padEnd(4)} ${d.title}`).join("\n")
        : "no feedback drafts",
    );
    return 0;
  }

  if (sub === "show" || sub === "submit") {
    const id = rest[0] ?? "";
    const draft = getDraft(id);
    if (!draft) throw new CliError("not_found", `no feedback draft '${id}' (brain feedback list)`, 3);
    if (sub === "show") {
      print(out, "feedback.show", { ...draft, url: draft.url ?? issueUrl(draft) }, null, () =>
        `${draft.title}\n\n${draft.body}\n\n${Object.entries(draft.diagnostics).map(([k, v]) => `${k}: ${v}`).join("\n")}`,
      );
      return 0;
    }
    if (!flags.post) {
      // The default: a person opens the page, reads it, and submits it.
      const url = issueUrl(draft);
      print(out, "feedback.submit", { id: draft.id, posted: false, url }, null, () =>
        `Open this link, review the report, and click "Submit new issue":\n${url}`,
      );
      return 0;
    }
    // Posting without a person in the loop needs their say-so: either they
    // allowed it on this machine, or they asked for this report to be posted.
    const allowed = userSettings().feedbackPost === "allow";
    if (!allowed && !flags["user-approved"]) {
      throw new CliError(
        "not_permitted",
        'posting needs the user\'s permission: they asked for it (--user-approved) or allowed it ("feedback": { "post": "allow" } in ~/.config/brain/config.json)',
        6,
      );
    }
    let posted: string;
    try {
      posted = postWithGh(draft);
    } catch (err) {
      throw new CliError("post_failed", `gh issue create failed (${(err as Error).message.split("\n")[0]}); submit by link instead: brain feedback submit ${draft.id}`, 1);
    }
    const done = markSubmitted(draft, posted);
    print(out, "feedback.submit", { id: done.id, posted: true, url: posted }, null, () => posted);
    return 0;
  }

  // Create a draft: brain feedback "<what happened>" [--kind] [--title] [--from-last-error]
  const text = (sub === "add" ? rest : args).join(" ").trim();
  const last = flags["from-last-error"] ? lastError() : null;
  if (flags["from-last-error"] && !last) throw new CliError("not_found", "no recorded error on this machine", 3);
  if (!text && !last) {
    throw new CliError("usage", 'usage: brain feedback "<what happened>" [--kind bug|idea|docs] [--title …] [--from-last-error]', 2);
  }
  const kind = (flags.kind as string | undefined) ?? "bug";
  if (!(KINDS as readonly string[]).includes(kind)) throw new CliError("usage", `--kind must be one of: ${KINDS.join(", ")}`, 2);

  // Redact against this vault when there is one: its path and every note's
  // path and title become placeholders.
  let vault: string | null = null;
  let notes: { path: string; title: string }[] = [];
  let s: Store | null = null;
  try {
    vault = findVault(flags.vault as string | undefined);
    s = Store.open(vault);
    s.refresh();
    notes = s.db.prepare("SELECT path, title FROM notes").all() as { path: string; title: string }[];
  } catch {
    vault = null;
  } finally {
    s?.close();
  }
  const redact = redactor({ vault, notes });
  const body = [
    text || "(no description)",
    ...(last
      ? ["", "### What failed", "", "```", `brain ${last.args.join(" ")}`, `exit ${last.exit} · ${last.code}`, last.message, "```"]
      : []),
  ].join("\n");
  const title = (flags.title as string | undefined)?.trim() || (last ? `${last.command}: ${last.code}` : text.split("\n")[0]!.slice(0, 80));
  const draft = createDraft(
    {
      kind: kind as Kind,
      title,
      body,
      diagnostics: diagnostics(VERSION, last ? { command: last.command, error: last.code, exit: String(last.exit) } : {}),
      fingerprintSeed: last ? `${last.command}|${last.code}|${VERSION}` : `${kind}|${title.toLowerCase()}`,
    },
    redact,
  );
  print(out, "feedback.add", { draft, repo: repo() }, null, () =>
    [
      `drafted ${draft.id} (${draft.kind}) — redacted preview:`,
      "",
      `  ${draft.title}`,
      ...draft.body.split("\n").map((l) => `  ${l}`),
      "",
      `review: brain feedback show ${draft.id}`,
      `submit: brain feedback submit ${draft.id}   (prints a link for a person to submit)`,
    ].join("\n"),
  );
  return 0;
}

function brief(st: LifecycleState | undefined) {
  if (!st) return null;
  return { category: st.category, asOf: st.asOf, reviewed: st.reviewed, due: st.due, overdue: st.overdue, archived: st.archived, reason: st.reason };
}

function staleMark(h: { lifecycle?: ReturnType<typeof brief> }): string {
  if (!h.lifecycle) return "";
  if (h.lifecycle.archived) return "  [archived]";
  return h.lifecycle.overdue ? `  [stale: review was due ${h.lifecycle.due}]` : "";
}

function formatFindings(findings: { rule: string; severity: string; path: string; message: string }[]): string {
  const lines: string[] = [];
  let rule = "";
  for (const f of findings) {
    if (f.rule !== rule) {
      rule = f.rule;
      const n = findings.filter((x) => x.rule === rule).length;
      lines.push(`${lines.length ? "\n" : ""}${f.severity.toUpperCase()} ${rule} (${n})`);
    }
    lines.push(`  ${f.path}: ${f.message}`);
  }
  return lines.join("\n");
}

interface Check {
  check: string;
  status: "ok" | "warn";
  detail: string;
}

// Each check names what it found and, when it warns, what to do. Nothing here
// changes anything: doctor only reads.
function doctor(vault: string, cfg: Config, index: RefreshStats, notes: number): Check[] {
  const checks: Check[] = [];
  const synced = /\/Library\/Mobile Documents\/|\/Library\/CloudStorage\/|\/Dropbox\/|\/OneDrive\//.test(vault + "/");
  const mode = resolveSyncMode(vault, cfg);
  checks.push({ check: "vault", status: "ok", detail: `${vault} (${notes} notes)` });
  checks.push({
    check: "index",
    status: indexDir(vault).startsWith(vault + "/") ? "warn" : "ok",
    detail: `${indexDir(vault)}${indexDir(vault).startsWith(vault + "/") ? " is inside the vault; set BRAIN_STATE_DIR outside it" : " (outside the vault, never synced)"}`,
  });
  checks.push({
    check: "sync",
    status: "ok",
    detail: typeof cfg.sync === "object" ? `command: ${cfg.sync.command}` : `${cfg.sync}${cfg.sync === "auto" ? ` → ${mode}` : ""}${synced ? " (vault is in a cloud-synced folder)" : ""}`,
  });
  if (synced && isGitRepo(vault)) {
    checks.push({
      check: "git in a synced folder",
      status: "warn",
      detail:
        "the vault is a git repository inside iCloud/Dropbox/OneDrive. Two sync systems on one folder can corrupt .git. " +
        "Keep git out of the synced copy (a separate clone, or .git moved to .git.nosync with a .git symlink for iCloud), " +
        'or pick one: "sync": "none" if the cloud folder is the sync.',
    });
  }
  if (index.offline) {
    checks.push({
      check: "offline notes",
      status: "warn",
      detail: `${index.offline} note(s) are cloud placeholders on this machine; search uses what was last indexed, get cannot read them. ` +
        'Turn off "Optimize Mac Storage" for the vault folder, or keep it downloaded.',
    });
  }
  for (const v of cfg.exports) {
    checks.push({ check: `view ${v.kind}`, status: existsSync(dirname(v.path)) ? "ok" : "warn", detail: existsSync(dirname(v.path)) ? v.path : `${dirname(v.path)} does not exist on this machine` });
  }
  if (cfg.as) checks.push({ check: "acting as", status: "ok", detail: cfg.as.name });
  return checks;
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
    if (existsSync(join(dir, ".obsidian")) || existsSync(join(dir, "brain.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CliError(
    "no_vault",
    "no vault found: pass --vault <dir>, set BRAIN_VAULT, or run inside a folder with .obsidian/ or brain.json",
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
          : err instanceof OfflineNoteError
            ? new CliError("offline", err.message, 1)
          : new CliError("internal", err instanceof Error ? err.message : String(err), 1);
  tError = e.code;
  if (command !== "feedback" && !command.startsWith("feedback.")) {
    saveLastError({
      time: new Date().toISOString(),
      command,
      args: process.argv.slice(2),
      code: e.code,
      exit: e.exit,
      message: e.message,
      version: VERSION,
    });
  }
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

// A section is its heading line plus everything up to the next heading of the
// same or higher level. Headings inside fenced code are not headings. Requests
// match a heading's text case-insensitively by prefix, so "Outcome Log"
// finds "## Outcome Log (pending first)". Sections come back in note order.
export function extractSections(
  markdown: string,
  wanted: string[],
  maxLines?: number,
): { content: string; found: string[]; missing: string[] } {
  const lines = markdown.split("\n");
  const headings: { line: number; level: number; text: string }[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const f = /^(```|~~~)/.exec(line);
    if (f) fence = fence === f[1] ? null : (fence ?? f[1]!);
    if (fence) return;
    const h = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(line);
    if (h) headings.push({ line: i, level: h[1]!.length, text: h[2]!.trim() });
  });
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const picked = new Map<number, string>();
  const missing: string[] = [];
  for (const w of wanted) {
    const exact = headings.findIndex((h) => norm(h.text) === norm(w));
    const idx = exact >= 0 ? exact : headings.findIndex((h) => norm(h.text).startsWith(norm(w)));
    if (idx < 0) missing.push(w);
    else picked.set(idx, headings[idx]!.text);
  }
  const order = [...picked.keys()].sort((a, b) => a - b);
  const blocks = order.map((idx) => {
    const h = headings[idx]!;
    const next = headings.slice(idx + 1).find((n) => n.level <= h.level);
    const end = next ? next.line : lines.length;
    const stop = maxLines === undefined ? end : Math.min(end, h.line + maxLines);
    return lines.slice(h.line, stop).join("\n").trimEnd();
  });
  return { content: blocks.join("\n\n") + (blocks.length ? "\n" : ""), found: order.map((i) => picked.get(i)!), missing };
}

function stem(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}
