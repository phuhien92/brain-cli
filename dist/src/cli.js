import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ConfigError, inScope, loadConfig, readScope, readUserConfig, slug, userSettings } from "./config.js";
import { applySetup, detectHarnesses, findVaultCandidates, interactiveSetup, recommendSync } from "./setup.js";
import { createDraft, diagnostics, getDraft, issueUrl, KINDS, lastError, listDrafts, markSubmitted, postWithGh, redactor, repo, saveLastError, } from "./feedback.js";
import * as telemetry from "./telemetry.js";
import { context, HARNESSES, install } from "./agent.js";
import { CATEGORIES, isDate, lifecycleStates, recordLifecycle, today, windows } from "./lifecycle.js";
import { lint } from "./lint.js";
import { addEntry, addEntryOnce, exportView, importFile, LIFECYCLE_KIND, listEntries, recordRetirement, renderView } from "./log.js";
import { OfflineNoteError, Store } from "./store.js";
import { brainPaths, describePaths, PATH_NAMES } from "./paths.js";
import { isGitRepo, resolveSyncMode, sync, SyncError } from "./sync.js";
import { ingest } from "./source.js";
import { ExtensionError, enabledExtensionNames, extensionBrainProcess, extensionProcess, installExtension, installedManifest, listExtensions, publicExtensionSource, removeExtension, resolveLauncher, } from "./extensions.js";
export const VERSION = "0.10.0";
// Bumped only on a breaking change to the --json envelope or a command's data shape.
export const SCHEMA = "brain.v1";
const HELP = `brain — headless memory for a markdown vault

USAGE
  brain <command> [args] [flags]

COMMANDS
  setup                       First-run walkthrough: vault, machine name, sync, agents,
                              telemetry, shell profile — each a choice; nothing is written
                              until you confirm. Non-interactive: --yes with --vault,
                              --machine, --sync auto|git|none, --agents claude,pi,agents,
                              --telemetry yes|no, --profile

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

  ingest <file>               Copy an immutable source into sources/ with searchable metadata
      --title <title>          Source title (default: the input file name)
      --tag <tag>             Tag the source (repeatable)

  log add <kind> <title>      Record an entry; --source-id <sha256> with --source-created <ISO time>
                               makes source imports create-only idempotent
      --body <text|->         Entry body (- reads stdin)
      --tag <tag>             Tag the entry (repeatable)
  log [n] [--kind <kind>]     Show the n most recent entries (default 10)
  log import <kind> <file>    Turn an existing memory file into entries, one per list item;
                              text already recorded is skipped; entries brain exported there
                              and now missing are listed as retirement candidates, same-title
                              body changes as replacement candidates; nothing is retired
  log retire <entry-id>       Retire an entry with an immutable lifecycle event
      --reason <text>         Optional reason for the retirement
  log replace <entry-id>      Retire an entry and add its replacement in one command
      --text <text>           Replacement title
      --body <text|->         Replacement body (- reads stdin)
  view <kind>                 Print every active <kind> entry as one markdown list, oldest first
  export [--force]            Write each configured view to its path as a regular file;
                              refuses (exit 5) if the file was edited since brain wrote it
  sync [--no-push]            Bring other machines' changes in and send ours out, by the
                              vault's sync mode (brain.json "sync"): git commits the log and sources,
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
  lint [--strict]             Report broken links, source integrity/provenance, orphans,
                              sync conflict copies, overdue reviews, lifecycle problems and
                              line limits (--strict: exit 7
                              if anything is reported at warn level)

  integrations                List the repos/tools connected to this vault, what each may
                              read and write, and their view paths on this machine
  doctor                      Check this machine's setup: vault, index location, sync
                              mode, iCloud placeholders, git inside a synced folder
  path [<name>]               Print where brain keeps things, one absolute path per name:
                              ${PATH_NAMES.join(", ")}.
                              No name: all of them. Reads only; creates nothing

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

  ext install <path|git-url>  Review permissions, then install on this machine and enable
                              for this vault (interactive terminal only)
  ext list                    List installed extensions and this vault's enablement
  ext remove <name>           Remove an extension from this machine; other machines and the
                              vault's enabled list are unchanged

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
  $BRAIN_EXTENSIONS_DIR       Installed extensions (default ~/.local/share/brain/extensions)

EXIT CODES
  0 ok · 1 error · 2 usage · 3 note not found · 4 ambiguous note reference
  5 conflict: sync hit notes edited on two machines, or export found unrecorded edits
  6 not permitted: outside the acting integration's scope · 7 lint --strict found warnings
`;
class CliError extends Error {
    code;
    exit;
    details;
    constructor(code, message, exit, details) {
        super(message);
        this.code = code;
        this.exit = exit;
        this.details = details;
    }
}
// Telemetry records a command by a name from these lists only. Anything else
// a user typed (a query, a note, feedback text) can never become a name.
const COMMANDS = ["setup", "index", "search", "get", "ingest", "log", "view", "export", "sync", "integrations", "doctor", "path", "lifecycle", "lint", "context", "agent", "feedback", "telemetry", "ext", "help"];
const BUILT_INS = new Set(COMMANDS);
const EXTENSION_CHILD_COMMANDS = new Set(["help", "search", "get", "log", "view", "lifecycle"]);
const EXTENSION_TIMEOUT_MS = 30_000;
const EXTENSION_OUTPUT_LIMIT = 1024 * 1024;
const EXTENSION_RUNTIME_ENVIRONMENT = new Set([
    "COMSPEC", "DO_NOT_TRACK", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR", "PATH",
    "PATHEXT", "SYSTEMROOT", "TEMP", "TERM", "TMP", "TMPDIR", "TZ", "USERPROFILE", "WINDIR",
]);
const SUBCOMMANDS = {
    log: ["add", "import", "retire", "replace"],
    lifecycle: ["set", "review", "archive", "restore", "status"],
    agent: ["install"],
    feedback: ["list", "show", "submit", "add"],
    telemetry: ["status", "show", "enable", "disable", "reset", "flush"],
    ext: ["install", "list", "remove"],
};
export function telemetryName(command, sub) {
    if (!COMMANDS.includes(command))
        return "unknown";
    return sub && SUBCOMMANDS[command]?.includes(sub) ? `${command}.${sub}` : command;
}
function extensionChildCommandAllowed(command, sub) {
    if (!EXTENSION_CHILD_COMMANDS.has(command))
        return false;
    if (command === "log")
        return !["import", "retire", "replace"].includes(sub ?? "");
    if (command === "lifecycle")
        return !["set", "review", "archive", "restore"].includes(sub ?? "");
    return true;
}
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "brain.js");
// Filled in while a command runs, read once it finishes, for telemetry.
let tCommand = "unknown";
let tError = null;
let tContext = {};
export async function main(argv) {
    const started = Date.now();
    tCommand = "unknown";
    tError = null;
    tContext = {};
    const json = argv.includes("--json");
    const position = commandPosition(argv);
    const first = position === -1 ? undefined : argv[position];
    const after = position === -1 ? undefined : argv[position + 1];
    const extensionCaller = process.env.BRAIN_EXTENSION_SCOPE;
    if (extensionCaller && first && !extensionChildCommandAllowed(first, after)) {
        return fail({ json, quiet: argv.includes("--quiet") || argv.includes("-q") }, first, new CliError("not_permitted", `extension '${extensionCaller}' may not run '${first}'`, 6));
    }
    if (telemetry.shouldAsk({ json, command: telemetryName(first ?? "help", after), userConfigTelemetry: userSettings().telemetry })) {
        try {
            await telemetry.ask();
        }
        catch {
            // a broken terminal never blocks the command
        }
    }
    const exit = await run(argv);
    // Managing telemetry is not usage of brain; it is never itself recorded.
    if (!tCommand.startsWith("telemetry")) {
        telemetry.record({ command: tCommand, exit, error: tError, ms: Date.now() - started, json: argv.includes("--json"), version: VERSION }, tContext, userSettings().telemetry, BIN);
    }
    return exit;
}
async function run(argv) {
    // Extension arguments are owned by the extension, so dispatch before the
    // strict built-in parser rejects flags it does not know (for example
    // `brain meetings import --since 7d`). The first positional is the command
    // in brain's documented syntax, and built-ins always take precedence.
    const position = commandPosition(argv);
    const leading = position === -1 ? undefined : argv[position];
    if (leading && !leading.startsWith("-") && !BUILT_INS.has(leading)) {
        const out = { json: argv.includes("--json"), quiet: argv.includes("--quiet") || argv.includes("-q") };
        try {
            return await runExtensionCommand(leading, [...argv.slice(position + 1), ...argv.slice(0, position)], out);
        }
        catch (err) {
            return fail(out, leading, err);
        }
    }
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
                "source-id": { type: "string" },
                "source-created": { type: "string" },
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
                text: { type: "string" },
                due: { type: "boolean", default: false },
                strict: { type: "boolean", default: false },
                "include-archived": { type: "boolean", default: false },
                title: { type: "string" },
                "from-last-error": { type: "boolean", default: false },
                post: { type: "boolean", default: false },
                yes: { type: "boolean", default: false },
                machine: { type: "string" },
                agents: { type: "string" },
                telemetry: { type: "string" },
                profile: { type: "boolean", default: false },
                "user-approved": { type: "boolean", default: false },
            },
        });
    }
    catch (err) {
        const json = argv.includes("--json");
        return fail({ json, quiet: false }, "unknown", new CliError("usage", err.message, 2));
    }
    const { values: flags, positionals } = parsed;
    const out = { json: flags.json ?? false, quiet: flags.quiet ?? false };
    const [command = "help", ...args] = positionals;
    tCommand = telemetryName(command, args[0]);
    const extensionCaller = process.env.BRAIN_EXTENSION_SCOPE;
    if (extensionCaller && !flags.version && !flags.help && !extensionChildCommandAllowed(command, args[0])) {
        const attempted = [command, args[0]].filter(Boolean).join(" ");
        return fail(out, command, new CliError("not_permitted", `extension '${extensionCaller}' may not run '${attempted}'`, 6));
    }
    if (flags.version) {
        print(out, "version", { version: VERSION }, null, () => VERSION);
        return 0;
    }
    if (flags.help || command === "help") {
        if (out.json)
            print(out, "help", { usage: HELP }, null, () => "");
        else
            process.stdout.write(HELP);
        return 0;
    }
    if (command === "setup") {
        try {
            return await setupCommand(flags, out);
        }
        catch (err) {
            return fail(out, "setup", err);
        }
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
            if (sub === "enable" || sub === "disable")
                telemetry.setEnabled(sub === "enable");
            if (sub === "reset")
                telemetry.resetInstallId();
            if (!["status", "show", "enable", "disable", "reset"].includes(sub)) {
                throw new CliError("usage", "usage: brain telemetry [status|show|enable|disable|reset]", 2);
            }
            const st = telemetry.status(settings.telemetry);
            if (sub === "show") {
                const events = telemetry.queue();
                print(out, "telemetry.show", { ...st, events }, null, () => events.length ? events.map((e) => JSON.stringify(e)).join("\n") : "no events queued");
                return 0;
            }
            print(out, `telemetry.${sub}`, st, null, () => [
                `telemetry: ${st.enabled ? "on" : "off"} (${st.reason})`,
                `collector: ${st.collector ?? "not configured — events stay on this machine"}`,
                `queued: ${st.queued} event(s) · install id: ${st.install}`,
                "what is collected: docs/telemetry.md · see it: brain telemetry show · stop: brain telemetry disable",
            ].join("\n"));
            return 0;
        }
        catch (err) {
            return fail(out, tCommand, err);
        }
    }
    if (command === "feedback") {
        try {
            return await feedbackCommand(args, flags, out);
        }
        catch (err) {
            return fail(out, tCommand, err);
        }
    }
    if (command === "ext") {
        try {
            return await extensionManagementCommand(args, flags, out);
        }
        catch (err) {
            return fail(out, tCommand, err);
        }
    }
    if (command === "agent") {
        try {
            const [sub, harness = ""] = args;
            if (sub !== "install" || !HARNESSES.includes(harness)) {
                throw new CliError("usage", `usage: brain agent install <${HARNESSES.join("|")}> [--dry-run] [--force]`, 2);
            }
            const result = install(harness, { force: flags.force, dryRun: flags["dry-run"] });
            const conflicts = result.files.filter((f) => f.status === "conflict");
            if (conflicts.length) {
                throw new CliError("install_conflict", `${conflicts.map((f) => f.path).join(", ")} exists and was not written by brain; rerun with --force to replace it`, 5, { files: conflicts.map((f) => f.path) });
            }
            print(out, "agent.install", { ...result, dryRun: flags["dry-run"] }, null, () => [
                ...result.files.map((f) => `${flags["dry-run"] && f.status === "written" ? "would write" : f.status}  ${f.path}`),
                ...result.warnings.map((w) => `warning: ${w}`),
                ...(result.next.length ? ["", ...result.next] : []),
            ].join("\n"));
            return 0;
        }
        catch (err) {
            return fail(out, "agent.install", err);
        }
    }
    if (command === "context") {
        // Runs inside other tools' session-start hooks: any failure prints nothing
        // and exits 0, so a missing vault never breaks the agent that called it.
        let ctxStore = null;
        try {
            const limit = flags.limit === undefined ? 5 : Math.max(0, Math.min(Number(flags.limit) || 0, 50));
            const vault = findVault(flags.vault);
            const cfg = loadConfig(vault, { as: flags.as });
            ctxStore = Store.open(vault);
            const index = ctxStore.refresh();
            const text = context(ctxStore, cfg, limit);
            print(out, "context", { context: text }, { vault, index }, () => text);
        }
        catch {
            if (out.json)
                print(out, "context", { context: "" }, null, () => "");
        }
        finally {
            ctxStore?.close();
        }
        return 0;
    }
    if (command === "path") {
        // Before Store.open on purpose: printing a location must not create it.
        try {
            const name = args[0];
            if (args.length > 1 || (name !== undefined && !PATH_NAMES.includes(name))) {
                throw new CliError("usage", `usage: brain path [${PATH_NAMES.join("|")}]`, 2, { names: [...PATH_NAMES] });
            }
            const vault = findVault(flags.vault);
            const cfg = loadConfig(vault, { as: flags.as });
            const all = describePaths(brainPaths(vault, cfg.logDir));
            const as = cfg.as ? { as: cfg.as.name } : {};
            if (name) {
                const p = all[name];
                print(out, command, { name, ...p, ...as }, null, () => p.path);
            }
            else {
                const width = Math.max(...PATH_NAMES.map((n) => n.length));
                print(out, command, { paths: all, ...as }, null, () => PATH_NAMES.map((n) => `${n.padEnd(width)}  ${all[n].path}${all[n].exists ? "" : "  (not created yet)"}`).join("\n"));
            }
            return 0;
        }
        catch (err) {
            return fail(out, command, err);
        }
    }
    let store = null;
    try {
        if (!["index", "search", "get", "ingest", "log", "view", "export", "sync", "integrations", "doctor", "lifecycle", "lint"].includes(command)) {
            throw new CliError("usage", `unknown command '${command}' — run 'brain help'`, 2);
        }
        const vault = findVault(flags.vault);
        const cfg = loadConfig(vault, { as: flags.as });
        const scope = readScope(cfg);
        const permit = (ok, what) => {
            if (!ok)
                throw new CliError("not_permitted", `integration '${cfg.as.name}' may not ${what}`, 6);
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
            case "ingest": {
                if (args.length !== 1)
                    throw new CliError("usage", "usage: brain ingest <file> [--title <title>] [--tag <tag>]", 2);
                if (cfg.as)
                    permit(false, "ingest sources");
                const file = resolve(args[0]);
                if (!existsSync(file))
                    throw new CliError("not_found", `no file at ${file}`, 3);
                const result = ingest(vault, cfg, { file, title: flags.title, tags: flags.tag });
                index = store.refresh();
                print(out, command, result, { vault, index }, () => result.new ? result.path : `${result.path} (already ingested)`);
                return 0;
            }
            case "index": {
                const data = { notes: store.count(), ...index };
                print(out, command, data, { vault, index }, () => `${vault}\n${data.notes} notes · +${index.added} ~${index.updated} -${index.removed} · ${index.ms}ms`);
                return 0;
            }
            case "search": {
                const query = args.join(" ").trim();
                if (!query)
                    throw new CliError("usage", "search needs a query: brain search <query>", 2);
                const limit = flags.limit === undefined ? 10 : Number(flags.limit);
                if (!Number.isInteger(limit) || limit < 1)
                    throw new CliError("usage", "--limit must be a positive integer", 2);
                let hits;
                try {
                    const states = lifecycleStates(store, cfg);
                    const hidden = [...states.values()].filter((st) => st.archived && !flags["include-archived"]).map((st) => st.path);
                    hits = store
                        .search(query, { limit, path: flags.path, tag: flags.tag?.[0], raw: flags.raw, scope, exclude: hidden, excludePrefix: `${cfg.logDir}/${LIFECYCLE_KIND}/` })
                        .map((h) => ({ ...h, lifecycle: brief(states.get(h.path)) }));
                }
                catch (err) {
                    if (flags.raw)
                        throw new CliError("bad_query", `invalid FTS5 query: ${err.message}`, 2);
                    throw err;
                }
                print(out, command, { query, results: hits }, { vault, index }, () => hits.length
                    ? hits
                        .map((h, i) => `${i + 1}. ${h.path}  (${h.score})${staleMark(h)}\n   ${h.title !== stem(h.path) ? h.title + " — " : ""}${h.snippet}`)
                        .join("\n")
                    : `no results for '${query}'`);
                return 0;
            }
            case "get": {
                const ref = args.join(" ").trim();
                if (!ref)
                    throw new CliError("usage", "get needs a note: brain get <path|name|title>", 2);
                // Out-of-scope notes are reported as not found, not as forbidden:
                // a restricted caller should not learn what else the vault holds.
                const matches = store.resolve(ref).filter((p) => inScope(p, scope));
                if (matches.length === 0)
                    throw new CliError("not_found", `no note matches '${ref}'`, 3);
                if (matches.length > 1) {
                    throw new CliError("ambiguous", `'${ref}' matches ${matches.length} notes — use a path`, 4, {
                        candidates: matches,
                    });
                }
                const note = { ...store.get(matches[0]), lifecycle: brief(lifecycleStates(store, cfg).get(matches[0])) };
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
                    print(out, command, data, { vault, index }, () => content + (missing.length ? `\n(no section matched: ${missing.join(", ")})` : ""));
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
                    let title = titleWords.join(" ").trim();
                    let tags = flags.tag;
                    if (!slug(kind) || !title)
                        throw new CliError("usage", 'usage: brain log add <kind> <title> [--body <text|->] [--tag t] [--source-id <sha256> --source-created <ISO time>]', 2);
                    if (cfg.as)
                        permit(cfg.as.write.includes(slug(kind)), `add '${slug(kind)}' entries (it may write: ${cfg.as.write.join(", ") || "nothing"})`);
                    let body = flags.body === "-" ? readFileSync(0, "utf8") : flags.body;
                    if (process.env.BRAIN_EXT_REDACT === "1") {
                        const redact = redactor({ vault });
                        title = redact(title);
                        tags = tags?.map((tag) => redact(tag));
                        if (body !== undefined) {
                            const original = String(body);
                            const protectedValues = [];
                            let guard = "brain-protected-value";
                            while (original.includes(guard))
                                guard += "-x";
                            const protect = (value) => {
                                protectedValues.push(value);
                                return `${guard}-${protectedValues.length - 1}-end`;
                            };
                            const token = process.env.BRAIN_EXT_REDACT_TOKEN;
                            const wrapper = token && /^[0-9a-f-]{36}$/.test(token)
                                ? new RegExp(`<!-- brain-protected-url:${token}:([A-Za-z0-9_-]+) -->`, "g")
                                : null;
                            const protectedBody = wrapper
                                ? original.replace(wrapper, (all, encoded) => {
                                    const value = Buffer.from(encoded, "base64url").toString("utf8");
                                    if (Buffer.from(value).toString("base64url") !== encoded)
                                        return all;
                                    try {
                                        const url = new URL(value);
                                        const safeUrl = (url.protocol === "https:" || url.protocol === "http:")
                                            && !url.username && !url.password && !url.search && !url.hash && url.toString() === value;
                                        if (!safeUrl)
                                            return all;
                                        if (redact(url.origin) !== url.origin)
                                            return "";
                                        let decodedPath = "";
                                        try {
                                            decodedPath = decodeURIComponent(url.pathname);
                                        }
                                        catch {
                                            return `${url.origin}/`;
                                        }
                                        return !decodedPath.includes("%") && redact(decodedPath) === decodedPath ? protect(value) : `${url.origin}/`;
                                    }
                                    catch {
                                        return all;
                                    }
                                })
                                : original;
                            body = redact(protectedBody).replace(new RegExp(`${guard}-(\\d+)-end`, "g"), (_all, index) => protectedValues[Number(index)] ?? "");
                        }
                    }
                    const input = { kind, title, body: body === undefined ? undefined : String(body), tags };
                    const sourceId = flags["source-id"];
                    const sourceCreated = flags["source-created"];
                    if (sourceId !== undefined && !/^[0-9a-f]{64}$/.test(sourceId)) {
                        throw new CliError("usage", "--source-id must be a SHA-256 hash", 2);
                    }
                    if ((sourceId === undefined) !== (sourceCreated === undefined)) {
                        throw new CliError("usage", "--source-id and --source-created must be used together", 2);
                    }
                    let sourceDate;
                    if (sourceCreated !== undefined) {
                        sourceDate = new Date(sourceCreated);
                        if (Number.isNaN(sourceDate.getTime()) || sourceDate.toISOString() !== sourceCreated) {
                            throw new CliError("usage", "--source-created must be a canonical ISO timestamp", 2);
                        }
                    }
                    const sourceMachine = process.env.BRAIN_EXTENSION_SCOPE || "source";
                    const result = sourceId === undefined
                        ? { path: addEntry(vault, cfg, input), added: true, machine: cfg.machine }
                        : addEntryOnce(store, cfg, input, sourceId, sourceDate, sourceMachine);
                    index = store.refresh();
                    print(out, "log.add", { ...result, kind: slug(kind) }, { vault, index }, () => result.added ? result.path : `already recorded: ${result.path}`);
                    return 0;
                }
                if (sub === "import") {
                    const [kind = "", file = ""] = rest;
                    if (!slug(kind) || !file || rest.length !== 2)
                        throw new CliError("usage", "usage: brain log import <kind> <file>", 2);
                    if (cfg.as)
                        permit(cfg.as.write.includes(slug(kind)), `import '${slug(kind)}' entries`);
                    const abs = resolve(file);
                    if (!existsSync(abs))
                        throw new CliError("not_found", `no file at ${abs}`, 3);
                    const result = importFile(store, cfg, kind, abs);
                    index = store.refresh();
                    print(out, "log.import", { file: abs, kind: slug(kind), ...result }, { vault, index }, () => {
                        const summary = `imported ${result.added.length} ${slug(kind)} entries from ${abs}` +
                            (result.skipped ? ` (${result.skipped} already recorded)` : "");
                        const lines = [summary];
                        if (result.retirementCandidates.length) {
                            lines.push(`${result.retirementCandidates.length} entries brain exported to this file are no longer in it; review them before deciding whether to retire:`, ...result.retirementCandidates.map((candidate) => `  path: ${JSON.stringify(candidate.path)}; title: ${JSON.stringify(candidate.title)}; body: ${JSON.stringify(candidate.body)}` +
                                (candidate.reason ? `; reason: ${JSON.stringify(candidate.reason)}` : "")));
                        }
                        if (result.replacementCandidates.length) {
                            lines.push(`${result.replacementCandidates.length} entries brain exported to this file have a new body there; not imported until replaced (brain log replace <path> --text <title> --body <body>):`, ...result.replacementCandidates.map((candidate) => `  path: ${JSON.stringify(candidate.path)}; title: ${JSON.stringify(candidate.title)}; body: ${JSON.stringify(candidate.body)}; new body: ${JSON.stringify(candidate.replacement.body)}`));
                        }
                        return lines.join("\n");
                    });
                    return 0;
                }
                if (sub === "retire" || sub === "replace") {
                    if (rest.length !== 1) {
                        throw new CliError("usage", `usage: brain log ${sub} <entry-id>${sub === "replace" ? " --text <title> [--body <text|->]" : " [--reason <text>]"}`, 2);
                    }
                    const target = resolveLogEntry(store, cfg, rest[0], scope);
                    if (cfg.as) {
                        permit(cfg.as.write.includes(target.kind), `${sub} '${target.kind}' entries`);
                        // The retirement is a lifecycle event, so it needs that write kind too.
                        permit(cfg.as.write.includes(LIFECYCLE_KIND), `${sub} entries (add "${LIFECYCLE_KIND}" to its write kinds)`);
                    }
                    if (sub === "retire") {
                        const reason = flags.reason?.trim().replace(/\s+/g, " ") || undefined;
                        const event = recordRetirement(vault, cfg, target.path, { reason });
                        index = store.refresh();
                        print(out, "log.retire", { target: target.path, event, reason: reason ?? null }, { vault, index }, () => `${target.path}: retired  (${event})`);
                        return 0;
                    }
                    const text = flags.text?.trim();
                    if (!text)
                        throw new CliError("usage", "replace needs --text <title>", 2);
                    const body = flags.body === "-" ? readFileSync(0, "utf8") : flags.body;
                    const replacement = addEntry(vault, cfg, {
                        kind: target.kind,
                        title: text,
                        body: body === undefined ? undefined : String(body).trim(),
                        tags: target.tags,
                    });
                    const event = recordRetirement(vault, cfg, target.path, {
                        reason: `replaced by ${replacement}`,
                        replacement,
                    });
                    index = store.refresh();
                    print(out, "log.replace", { target: target.path, replacement, event }, { vault, index }, () => `${target.path}: retired and replaced by ${replacement}  (${event})`);
                    return 0;
                }
                const n = sub === undefined ? 10 : Number(sub);
                if (!Number.isInteger(n) || n < 1 || rest.length) {
                    throw new CliError("usage", "usage: brain log [n] [--kind k] | log add <kind> <title> | log import <kind> <file> | log retire <entry-id> | log replace <entry-id> --text <title> [--body <text>]", 2);
                }
                const entries = listEntries(store, cfg, { kind: flags.kind ? slug(flags.kind) : undefined, limit: scope ? -1 : n })
                    .filter((e) => inScope(e.path, scope))
                    .slice(0, n);
                print(out, "log", { entries }, { vault, index }, () => entries.length
                    ? entries.map((e) => `${e.created.slice(0, 10)}  ${e.kind.padEnd(10)} ${e.machine.padEnd(12)} ${e.title}`).join("\n")
                    : "no entries yet — add one with: brain log add <kind> <title>");
                return 0;
            }
            case "view": {
                const kind = slug(args[0] ?? "");
                if (!kind)
                    throw new CliError("usage", "usage: brain view <kind>", 2);
                if (cfg.as)
                    permit(inScope(`${cfg.logDir}/${kind}/`, scope), `read '${kind}' entries`);
                const entries = listEntries(store, cfg, { kind });
                const markdown = renderView(entries);
                print(out, command, { kind, entries: entries.length, markdown }, { vault, index }, () => markdown);
                return 0;
            }
            case "export": {
                const exports = runExports(store, cfg, flags.force);
                const drift = exports.filter((e) => e.status === "drift");
                if (drift.length) {
                    if (!out.json && !out.quiet)
                        process.stdout.write(formatExports(exports) + "\n");
                    throw new CliError("export_drift", driftMessage(drift), 5, { exports });
                }
                print(out, command, { exports }, { vault, index }, () => formatExports(exports) || "no exports configured");
                return 0;
            }
            case "sync": {
                const result = sync(vault, cfg, { push: !flags["no-push"] });
                index = store.refresh();
                const exports = runExports(store, cfg, false);
                print(out, command, { ...result, machine: cfg.machine, exports }, { vault, index }, () => [
                    result.mode === "none"
                        ? `${cfg.machine}: sync mode "none" — files are moved by your sync service; index refreshed`
                        : result.mode === "command"
                            ? `${cfg.machine}: ran the configured sync command`
                            : `${cfg.machine}: committed ${result.committed} · pulled ${result.pulled} · ` +
                                (result.remote ? (result.pushed ? "pushed" : "nothing to push") : "no upstream — local commit only"),
                    formatExports(exports),
                ]
                    .filter(Boolean)
                    .join("\n"));
                // The sync itself succeeded; unrecorded edits to an export are surfaced
                // in data.exports and on stderr rather than failing the whole sync.
                const drift = exports.filter((e) => e.status === "drift");
                if (drift.length && !out.json)
                    process.stderr.write(`brain: ${driftMessage(drift)}\n`);
                return 0;
            }
            case "lifecycle": {
                const [sub, ...rest] = args;
                const states = lifecycleStates(store, cfg);
                if (sub === "status") {
                    if (rest.length)
                        throw new CliError("usage", "usage: brain lifecycle status [--due]", 2);
                    const list = [...states.values()]
                        .filter((st) => inScope(st.path, scope))
                        .filter((st) => !flags.due || st.overdue)
                        .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.path.localeCompare(b.path));
                    print(out, "lifecycle.status", { today: today(), notes: list }, { vault, index }, () => list.length
                        ? list
                            .map((st) => `${st.overdue ? "OVERDUE " : st.archived ? "archived" : "        "} ${(st.category ?? "-").padEnd(13)} due ${st.due ?? "-         "}  ${st.path}` +
                            (st.problems.length ? `\n         ! ${st.problems.join("; ")}` : ""))
                            .join("\n")
                        : flags.due
                            ? "nothing is overdue"
                            : "no notes have lifecycle data yet — start with: brain lifecycle set <note> --category <category>");
                    return 0;
                }
                if (!["set", "review", "archive", "restore"].includes(sub ?? "")) {
                    throw new CliError("usage", "usage: brain lifecycle set|review|archive|restore <note> … | lifecycle status [--due]", 2);
                }
                const ref = rest.join(" ").trim();
                if (!ref)
                    throw new CliError("usage", `usage: brain lifecycle ${sub} <note>`, 2);
                const matches = store.resolve(ref).filter((p) => inScope(p, scope));
                if (matches.length === 0)
                    throw new CliError("not_found", `no note matches '${ref}'`, 3);
                if (matches.length > 1) {
                    throw new CliError("ambiguous", `'${ref}' matches ${matches.length} notes — use a path`, 4, { candidates: matches });
                }
                const target = matches[0];
                if (cfg.as)
                    permit(cfg.as.write.includes(LIFECYCLE_KIND), `record lifecycle changes (add "${LIFECYCLE_KIND}" to its write kinds)`);
                const date = (flag, v) => {
                    if (v !== undefined && !isDate(v))
                        throw new CliError("usage", `--${flag} must be a YYYY-MM-DD date`, 2);
                    return v;
                };
                let change;
                if (sub === "set") {
                    const category = flags.category;
                    if (!category || !CATEGORIES.includes(category)) {
                        throw new CliError("usage", `--category must be one of: ${CATEGORIES.join(", ")}`, 2);
                    }
                    const asOf = date("as-of", flags["as-of"]);
                    const w = windows(cfg)[category];
                    if (w !== null && !asOf && !states.get(target)?.asOf) {
                        throw new CliError("usage", `${category} is time-bound: give --as-of YYYY-MM-DD (when the note was true)`, 2);
                    }
                    change = { action: "set", category: category, asOf };
                }
                else if (sub === "review") {
                    change = { action: "review", on: date("on", flags.on) ?? today(), asOf: date("as-of", flags["as-of"]) };
                }
                else if (sub === "archive") {
                    if (!flags.reason?.trim())
                        throw new CliError("usage", 'archive needs --reason "..." (why it is no longer active)', 2);
                    change = { action: "archive", reason: flags.reason.trim().replace(/\s+/g, " ") };
                }
                else {
                    change = { action: "restore" };
                }
                const entry = recordLifecycle(vault, cfg, target, change);
                index = store.refresh();
                const st = lifecycleStates(store, cfg).get(target);
                print(out, `lifecycle.${sub}`, { entry, state: st }, { vault, index }, () => `${target}: ${st.archived ? "archived" : st.category ?? "no category"}${st.due ? `, next review ${st.due}` : ""}  (${entry})`);
                return 0;
            }
            case "lint": {
                const findings = lint(store, cfg);
                const counts = { warn: findings.filter((f) => f.severity === "warn").length, info: findings.filter((f) => f.severity === "info").length };
                if (flags.strict && counts.warn) {
                    if (!out.json && !out.quiet)
                        process.stdout.write(formatFindings(findings) + "\n");
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
                print(out, command, { integrations: list, as: cfg.as?.name ?? null }, { vault, index }, () => list.length
                    ? list
                        .map((i) => [
                        `${i.acting ? "* " : ""}${i.name}`,
                        `    read:  ${i.read.join(", ") || "(only its own log)"}`,
                        `    write: ${i.write.join(", ") || "(nothing)"}`,
                        ...(i.views.length ? i.views.map((v) => `    view:  ${v.kind} → ${v.path}`) : ["    view:  (none on this machine)"]),
                    ].join("\n"))
                        .join("\n")
                    : 'no integrations yet — declare one under "integrations" in brain.json (see docs/integrations.md)');
                return 0;
            }
            case "doctor": {
                const checks = doctor(vault, cfg, index, store.count());
                print(out, command, { checks }, { vault, index }, () => checks.map((c) => `${c.status === "ok" ? "ok  " : "WARN"}  ${c.check}: ${c.detail}`).join("\n"));
                return 0;
            }
        }
        return 0;
    }
    catch (err) {
        return fail(out, command, err);
    }
    finally {
        store?.close();
    }
}
async function extensionManagementCommand(args, flags, out) {
    const [sub, ...rest] = args;
    const vault = findVault(flags.vault);
    if (sub === "install") {
        if (rest.length !== 1)
            throw new CliError("usage", "usage: brain ext install <path|git-url>", 2);
        // Permission approval is a human decision. JSON callers, redirected
        // processes, hooks and CI are never prompted and have no bypass flag.
        if (out.json || process.stdin.isTTY !== true || process.stderr.isTTY !== true || process.env.CI) {
            throw new CliError("permission_confirmation_required", "extension install requires a person at an interactive terminal to review and approve its permissions", 6);
        }
        const result = await installExtension(rest[0], vault, confirmExtensionInstall);
        print(out, "ext.install", result, null, () => result.installed
            ? `installed ${result.manifest.name} ${result.manifest.version} in ${result.directory}\nenabled for ${vault}`
            : `cancelled; ${result.manifest.name} was not installed`);
        return 0;
    }
    if (sub === "list") {
        if (rest.length)
            throw new CliError("usage", "usage: brain ext list", 2);
        const extensions = listExtensions(vault);
        print(out, "ext.list", { extensions }, null, () => extensions.length
            ? extensions.map((extension) => {
                const version = extension.manifest?.version ? ` ${extension.manifest.version}` : "";
                const status = extension.installed ? (extension.enabled ? "enabled" : "disabled") : "missing";
                return `${extension.name}${version}  ${status}${extension.error ? `  (${extension.error})` : ""}`;
            }).join("\n")
            : "no extensions installed");
        return 0;
    }
    if (sub === "remove") {
        if (rest.length !== 1)
            throw new CliError("usage", "usage: brain ext remove <name>", 2);
        const result = removeExtension(rest[0]);
        const stillEnabled = enabledExtensionNames(vault).includes(result.name);
        print(out, "ext.remove", { ...result, stillEnabled }, null, () => `removed ${result.name} from this machine${stillEnabled ? "; it remains enabled for this vault and on other machines" : ""}`);
        return 0;
    }
    throw new CliError("usage", "usage: brain ext install <path|git-url> | ext list | ext remove <name>", 2);
}
async function confirmExtensionInstall(manifest) {
    const show = (values, empty) => values.length ? values.join(", ") : empty;
    process.stderr.write([
        "",
        `Extension: ${manifest.name} ${manifest.version}`,
        ...(manifest.description ? [`  ${manifest.description}`] : []),
        `  reads:    ${show(manifest.permissions.read, "nothing")}`,
        `  writes:   ${show(manifest.permissions.write, "nothing")}`,
        `  contacts: ${show(manifest.permissions.network, "no hosts declared")}`,
        `  receives: ${show(manifest.permissions.environment ?? [], "no ambient variables")}`,
        "",
        "This is code that runs with your operating-system permissions. brain enforces its",
        "read/write scope when it calls brain; declared network hosts are not sandboxed.",
    ].join("\n") + "\n");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        const answer = await new Promise((done) => rl.question(`Install and enable ${manifest.name} for this vault? [y/N] `, done));
        return /^\s*(y|yes)\s*$/i.test(answer);
    }
    finally {
        rl.close();
    }
}
function extensionBrainRunner(locked) {
    const directory = mkdtempSync(join(tmpdir(), "brain-extension-"));
    const path = join(directory, "brain.mjs");
    const launch = extensionBrainProcess(path);
    const values = { ...locked, BRAIN_BIN: launch.file, BRAIN_BIN_ARGS_JSON: JSON.stringify(launch.args) };
    writeFileSync(path, `const locked = ${JSON.stringify(values)};
for (const [key, value] of Object.entries(locked)) {
  if (value === null) delete process.env[key];
  else process.env[key] = value;
}
await import(${JSON.stringify(pathToFileURL(BIN).href)});
`);
    return { directory, file: launch.file, args: launch.args };
}
function extensionEnvironment(manifest) {
    const allowed = new Set([...EXTENSION_RUNTIME_ENVIRONMENT, ...(manifest.permissions.environment ?? [])]);
    const normalized = process.platform === "win32"
        ? new Set([...allowed].map((key) => key.toUpperCase()))
        : allowed;
    return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && normalized.has(process.platform === "win32" ? key.toUpperCase() : key)));
}
function commandPosition(argv) {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--vault" || arg === "--as") {
            if (i + 1 >= argv.length)
                return -1;
            i++;
        }
        else if (arg === "--json" || arg === "--quiet" || arg === "-q" || arg.startsWith("--vault=") || arg.startsWith("--as=")) {
            continue;
        }
        else {
            return arg.startsWith("-") ? -1 : i;
        }
    }
    return -1;
}
function killExtensionTree(child) {
    if (child.pid && process.platform === "win32") {
        const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        if (killed.status === 0)
            return;
    }
    else if (child.pid) {
        try {
            process.kill(-child.pid, "SIGKILL");
            return;
        }
        catch { }
    }
    child.kill("SIGKILL");
}
function extensionInvocation(args) {
    const forwarded = [];
    let vault;
    let as;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--vault" || arg === "--as") {
            const value = args[++i];
            if (!value)
                throw new CliError("usage", `${arg} needs a value`, 2);
            if (arg === "--vault")
                vault = value;
            else
                as = value;
        }
        else if (arg.startsWith("--vault="))
            vault = arg.slice("--vault=".length);
        else if (arg.startsWith("--as="))
            as = arg.slice("--as=".length);
        else
            forwarded.push(arg);
    }
    return { args: forwarded, vault, as };
}
async function runExtensionCommand(name, rawArgs, out) {
    const invocation = extensionInvocation(rawArgs);
    const vault = findVault(invocation.vault);
    const parentAs = invocation.as ?? process.env.BRAIN_AS ?? "";
    const cfg = loadConfig(vault, { as: parentAs || undefined });
    const installed = installedManifest(name);
    if (!enabledExtensionNames(vault).includes(name)) {
        if (!installed)
            throw new CliError("usage", `unknown command '${name}' — run 'brain help'`, 2);
        throw new CliError("not_found", `extension '${name}' is not enabled for this vault`, 3);
    }
    if (!installed)
        throw new CliError("not_found", `extension '${name}' is not installed on this machine`, 3);
    const launcher = resolveLauncher(installed.directory, installed.manifest);
    const redactToken = randomUUID();
    const childRunner = extensionBrainRunner({
        BRAIN_VAULT: vault,
        BRAIN_CONFIG: process.env.BRAIN_CONFIG ?? null,
        BRAIN_STATE_DIR: process.env.BRAIN_STATE_DIR ?? null,
        BRAIN_EXTENSIONS_DIR: dirname(installed.directory),
        BRAIN_AS: parentAs || installed.manifest.name,
        BRAIN_MACHINE: cfg.machine,
        BRAIN_EXTENSION_SCOPE: installed.manifest.name,
        BRAIN_EXTENSION_PARENT_AS: parentAs || null,
        BRAIN_EXT_REDACT: "1",
        BRAIN_EXT_REDACT_TOKEN: redactToken,
    });
    const env = {
        ...extensionEnvironment(installed.manifest),
        BRAIN_VAULT: vault,
        BRAIN_BIN: childRunner.file,
        BRAIN_BIN_ARGS_JSON: JSON.stringify(childRunner.args),
        BRAIN_AS: parentAs || installed.manifest.name,
        BRAIN_EXT_DIR: installed.directory,
        BRAIN_MACHINE: cfg.machine,
        BRAIN_EXTENSION_SCOPE: installed.manifest.name,
        BRAIN_EXT_REDACT: "1",
        BRAIN_EXT_REDACT_TOKEN: redactToken,
    };
    if (parentAs)
        env.BRAIN_EXTENSION_PARENT_AS = parentAs;
    else
        delete env.BRAIN_EXTENSION_PARENT_AS;
    const result = await new Promise((done) => {
        const launch = extensionProcess(launcher, invocation.args);
        delete env.BRAIN_EXTENSION_ARGS_JSON;
        delete env.BRAIN_EXTENSION_LAUNCHER;
        const child = spawn(launch.file, launch.args, {
            cwd: installed.directory,
            detached: process.platform !== "win32",
            env: { ...env, ...launch.env },
            stdio: ["inherit", "pipe", "pipe"],
            windowsVerbatimArguments: launch.windowsVerbatimArguments,
        });
        const stdout = [];
        const stderr = [];
        let outputBytes = 0;
        let spawnError;
        let policyError;
        const stop = (error) => {
            if (policyError)
                return;
            policyError = error;
            child.stdout.destroy();
            child.stderr.destroy();
            killExtensionTree(child);
        };
        const capture = (chunks) => (chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > EXTENSION_OUTPUT_LIMIT) {
                stop(new ExtensionError("extension_output_limit", `${name} exceeded the 1 MiB output limit`));
                return;
            }
            chunks.push(chunk);
        };
        child.stdout.on("data", capture(stdout));
        child.stderr.on("data", capture(stderr));
        child.on("error", (err) => (spawnError = err));
        const timeout = setTimeout(() => stop(new ExtensionError("extension_timeout", `${name} exceeded the 30 second time limit`)), EXTENSION_TIMEOUT_MS);
        child.on("close", (code, signal) => {
            clearTimeout(timeout);
            done({
                code,
                signal,
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
                ...(spawnError ? { error: spawnError } : {}),
                ...(policyError ? { policyError } : {}),
            });
        });
    }).finally(() => rmSync(childRunner.directory, { recursive: true, force: true }));
    if (result.stderr)
        process.stderr.write(result.stderr);
    if (result.policyError)
        throw result.policyError;
    if (result.error)
        throw new ExtensionError("extension_failed", `${name} could not start: ${result.error.message}`);
    if (result.signal)
        throw new ExtensionError("extension_failed", `${name} was terminated by ${result.signal}`);
    const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
    let envelope = null;
    if (lines.length === 1) {
        try {
            const parsed = JSON.parse(lines[0]);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                envelope = parsed;
        }
        catch {
            // Report a protocol error below without echoing arbitrary extension output.
        }
    }
    const envelopeError = envelope?.error;
    const validError = !!envelopeError
        && typeof envelopeError === "object"
        && !Array.isArray(envelopeError)
        && typeof envelopeError.code === "string"
        && envelopeError.code !== ""
        && typeof envelopeError.message === "string";
    const valid = envelope?.schema === SCHEMA
        && typeof envelope.command === "string"
        && typeof envelope.ok === "boolean"
        && (envelope.ok === true
            ? Object.hasOwn(envelope, "data") && !Object.hasOwn(envelope, "error")
            : !Object.hasOwn(envelope, "data") && Object.hasOwn(envelope, "error") && validError);
    if (!valid) {
        throw new ExtensionError("extension_protocol", `${name} must print exactly one ${SCHEMA} JSON envelope; received ${lines.length} non-empty stdout line(s)`);
    }
    if ((envelope.ok === true && result.code !== 0) || (envelope.ok === false && result.code === 0)) {
        throw new ExtensionError("extension_protocol", `${name} returned an exit code that disagrees with its envelope`);
    }
    if (envelope.ok === false) {
        tError = "extension_failed";
    }
    if (envelope.ok === false || out.json || !out.quiet)
        process.stdout.write(lines[0].trim() + "\n");
    return result.code ?? 1;
}
async function setupCommand(flags, out) {
    const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true && !flags.yes && !out.json;
    let choices;
    if (interactive) {
        choices = await interactiveSetup();
        if (!choices) {
            process.stderr.write("Nothing was written.\n");
            return 0;
        }
    }
    else {
        if (!flags.yes) {
            throw new CliError("usage", "setup asks questions in a terminal; elsewhere pass --yes with the choices as flags (brain help)", 2);
        }
        const vaultFlag = flags.vault;
        const vault = vaultFlag ? resolve(vaultFlag) : findVaultCandidates()[0];
        if (!vault || !existsSync(vault))
            throw new CliError("no_vault", "no vault given or found: pass --vault <dir>", 1);
        const sync = flags.sync ?? recommendSync(vault).mode;
        if (!["auto", "git", "none"].includes(sync))
            throw new CliError("usage", "--sync must be auto, git or none", 2);
        const agents = flags.agents === undefined ? detectHarnesses() : String(flags.agents).split(",").map((a) => a.trim()).filter(Boolean);
        for (const a of agents)
            if (!["claude", "pi", "agents"].includes(a))
                throw new CliError("usage", `unknown agent harness '${a}'`, 2);
        const t = flags.telemetry;
        if (t !== undefined && !["yes", "no"].includes(t))
            throw new CliError("usage", "--telemetry must be yes or no", 2);
        const machine = slug(flags.machine ?? String(readUserConfig().machine ?? "")) || slug(hostname().replace(/\.local$/i, ""));
        choices = {
            vault,
            machine,
            sync: sync,
            agents: agents,
            telemetry: t === undefined ? null : t === "yes",
            profile: flags.profile === true,
        };
    }
    const result = applySetup(choices);
    const conflicts = result.installs.flatMap((r) => r.files.filter((f) => f.status === "conflict").map((f) => f.path));
    print(out, "setup", { ...result, conflicts }, null, () => [
        `\nWrote ${result.configPath}`,
        ...result.installs.flatMap((r) => [`${r.harness}:`, ...r.files.map((f) => `  ${f.status}  ${f.path}`), ...r.warnings.map((w) => `  warning: ${w}`), ...r.next.flatMap((n) => n.split("\n")).map((n) => `  ${n}`)]),
        ...(conflicts.length ? [`Not replaced (not written by brain; rerun brain agent install <harness> --force): ${conflicts.join(", ")}`] : []),
        result.profile ? (result.profile.added ? `Added to ${result.profile.file}: ${result.profile.line}` : `${result.profile.file} already sets BRAIN_VAULT`) : "",
        "",
        "Next: brain doctor (checks this machine) · brain search \"something you know is in there\"",
    ]
        .filter((l) => l !== "")
        .join("\n"));
    return 0;
}
async function feedbackCommand(args, flags, out) {
    const [sub, ...rest] = args;
    if (sub === "list") {
        const drafts = listDrafts();
        print(out, "feedback.list", { drafts }, null, () => drafts.length
            ? drafts.map((d) => `${d.id}  ${d.status.padEnd(9)} ${d.kind.padEnd(4)} ${d.title}`).join("\n")
            : "no feedback drafts");
        return 0;
    }
    if (sub === "show" || sub === "submit") {
        const id = rest[0] ?? "";
        const draft = getDraft(id);
        if (!draft)
            throw new CliError("not_found", `no feedback draft '${id}' (brain feedback list)`, 3);
        if (sub === "show") {
            print(out, "feedback.show", { ...draft, url: draft.url ?? issueUrl(draft) }, null, () => `${draft.title}\n\n${draft.body}\n\n${Object.entries(draft.diagnostics).map(([k, v]) => `${k}: ${v}`).join("\n")}`);
            return 0;
        }
        if (!flags.post) {
            // The default: a person opens the page, reads it, and submits it.
            const url = issueUrl(draft);
            print(out, "feedback.submit", { id: draft.id, posted: false, url }, null, () => `Open this link, review the report, and click "Submit new issue":\n${url}`);
            return 0;
        }
        // Posting without a person in the loop needs their say-so: either they
        // allowed it on this machine, or they asked for this report to be posted.
        const allowed = userSettings().feedbackPost === "allow";
        if (!allowed && !flags["user-approved"]) {
            throw new CliError("not_permitted", 'posting needs the user\'s permission: they asked for it (--user-approved) or allowed it ("feedback": { "post": "allow" } in ~/.config/brain/config.json)', 6);
        }
        let posted;
        try {
            posted = postWithGh(draft);
        }
        catch (err) {
            throw new CliError("post_failed", `gh issue create failed (${err.message.split("\n")[0]}); submit by link instead: brain feedback submit ${draft.id}`, 1);
        }
        const done = markSubmitted(draft, posted);
        print(out, "feedback.submit", { id: done.id, posted: true, url: posted }, null, () => posted);
        return 0;
    }
    // Create a draft: brain feedback "<what happened>" [--kind] [--title] [--from-last-error]
    const text = (sub === "add" ? rest : args).join(" ").trim();
    const last = flags["from-last-error"] ? lastError() : null;
    if (flags["from-last-error"] && !last)
        throw new CliError("not_found", "no recorded error on this machine", 3);
    if (!text && !last) {
        throw new CliError("usage", 'usage: brain feedback "<what happened>" [--kind bug|idea|docs] [--title …] [--from-last-error]', 2);
    }
    const kind = flags.kind ?? "bug";
    if (!KINDS.includes(kind))
        throw new CliError("usage", `--kind must be one of: ${KINDS.join(", ")}`, 2);
    // Redact against this vault when there is one: its path and every note's
    // path and title become placeholders.
    let vault = null;
    let notes = [];
    let s = null;
    try {
        vault = findVault(flags.vault);
        s = Store.open(vault);
        s.refresh();
        notes = s.db.prepare("SELECT path, title FROM notes").all();
    }
    catch {
        vault = null;
    }
    finally {
        s?.close();
    }
    const redact = redactor({ vault, notes });
    const body = [
        text || "(no description)",
        ...(last
            ? ["", "### What failed", "", "```", `brain ${last.args.join(" ")}`, `exit ${last.exit} · ${last.code}`, last.message, "```"]
            : []),
    ].join("\n");
    const title = flags.title?.trim() || (last ? `${last.command}: ${last.code}` : text.split("\n")[0].slice(0, 80));
    const draft = createDraft({
        kind: kind,
        title,
        body,
        diagnostics: diagnostics(VERSION, last ? { command: last.command, error: last.code, exit: String(last.exit) } : {}),
        fingerprintSeed: last ? `${last.command}|${last.code}|${VERSION}` : `${kind}|${title.toLowerCase()}`,
    }, redact);
    print(out, "feedback.add", { draft, repo: repo() }, null, () => [
        `drafted ${draft.id} (${draft.kind}) — redacted preview:`,
        "",
        `  ${draft.title}`,
        ...draft.body.split("\n").map((l) => `  ${l}`),
        "",
        `review: brain feedback show ${draft.id}`,
        `submit: brain feedback submit ${draft.id}   (prints a link for a person to submit)`,
    ].join("\n"));
    return 0;
}
function brief(st) {
    if (!st)
        return null;
    return { category: st.category, asOf: st.asOf, reviewed: st.reviewed, due: st.due, overdue: st.overdue, archived: st.archived, reason: st.reason };
}
function staleMark(h) {
    if (!h.lifecycle)
        return "";
    if (h.lifecycle.archived)
        return "  [archived]";
    return h.lifecycle.overdue ? `  [stale: review was due ${h.lifecycle.due}]` : "";
}
function formatFindings(findings) {
    const lines = [];
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
// Each check names what it found and, when it warns, what to do. Nothing here
// changes anything: doctor only reads.
function doctor(vault, cfg, index, notes) {
    const checks = [];
    const state = brainPaths(vault, cfg.logDir).state;
    const synced = /\/Library\/Mobile Documents\/|\/Library\/CloudStorage\/|\/Dropbox\/|\/OneDrive\//.test(vault + "/");
    const mode = resolveSyncMode(vault, cfg);
    checks.push({ check: "vault", status: "ok", detail: `${vault} (${notes} notes)` });
    checks.push({
        check: "index",
        status: state.startsWith(vault + "/") ? "warn" : "ok",
        detail: `${state}${state.startsWith(vault + "/") ? " is inside the vault; set BRAIN_STATE_DIR outside it" : " (outside the vault, never synced)"}`,
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
            detail: "the vault is a git repository inside iCloud/Dropbox/OneDrive. Two sync systems on one folder can corrupt .git. " +
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
    if (cfg.as)
        checks.push({ check: "acting as", status: "ok", detail: cfg.as.name });
    return checks;
}
function runExports(store, cfg, force) {
    return cfg.exports.map((t) => exportView(store, cfg, t, force));
}
function resolveLogEntry(store, cfg, ref, scope) {
    const entries = new Map(listEntries(store, cfg, { includeRetired: true })
        .filter((entry) => entry.kind !== LIFECYCLE_KIND)
        .map((entry) => [entry.path, entry]));
    const matches = store.resolve(ref)
        .filter((path) => inScope(path, scope))
        .map((path) => entries.get(path))
        .filter((entry) => entry !== undefined);
    if (matches.length === 0)
        throw new CliError("not_found", `no log entry matches '${ref}'`, 3);
    if (matches.length > 1) {
        throw new CliError("ambiguous", `'${ref}' matches ${matches.length} log entries — use a path`, 4, {
            candidates: matches.map((entry) => entry.path),
        });
    }
    return matches[0];
}
function formatExports(exports) {
    return exports.map((e) => `export ${e.kind} → ${e.path}: ${e.status} (${e.entries} entries)`).join("\n");
}
function driftMessage(drift) {
    return (`${drift.map((d) => d.path).join(", ")} changed since brain last wrote it. ` +
        `Capture those edits first (brain log import <kind> <file>), then run brain export --force.`);
}
// Always the real path: on macOS /var is a symlink to /private/var, and a vault
// found via the shell's cwd and one named in $BRAIN_VAULT must not be reported as
// two different vaults.
function findVault(flag) {
    return realpathSync(locateVault(flag));
}
function locateVault(flag) {
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
        if (existsSync(join(dir, ".obsidian")) || existsSync(join(dir, "brain.json")))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    // Last resort: the vault chosen in `brain setup` on this machine.
    try {
        const saved = readUserConfig().vault;
        if (typeof saved === "string" && existsSync(saved) && statSync(saved).isDirectory())
            return resolve(saved);
    }
    catch {
        // an unreadable config is reported by the commands that need it
    }
    throw new CliError("no_vault", "no vault found: run brain setup, pass --vault <dir>, set BRAIN_VAULT, or run inside a folder with .obsidian/ or brain.json", 1);
}
function print(out, command, data, ctx, human) {
    if (out.json) {
        const envelope = { schema: SCHEMA, command, ok: true, ...(ctx ?? {}), data };
        process.stdout.write(JSON.stringify(envelope) + "\n");
    }
    else if (!out.quiet) {
        const text = human();
        if (text)
            process.stdout.write(text.endsWith("\n") ? text : text + "\n");
    }
}
function fail(out, command, err) {
    const e = err instanceof CliError
        ? err
        : err instanceof SyncError
            ? new CliError(err.code, err.message, err.code === "sync_conflict" ? 5 : 1, err.files.length ? { files: err.files } : undefined)
            : err instanceof ExtensionError
                ? new CliError(err.code, err.message, err.exit, err.details)
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
            args: process.argv.slice(2).map(publicExtensionSource),
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
    }
    else {
        process.stderr.write(`brain: ${e.message}\n`);
        for (const key of ["candidates", "files"]) {
            const list = e.details?.[key];
            if (Array.isArray(list))
                for (const c of list)
                    process.stderr.write(`  ${c}\n`);
        }
    }
    return e.exit;
}
function formatMeta(note) {
    const lines = [`${note.path}`, `title: ${note.title}`];
    if (note.aliases.length)
        lines.push(`aliases: ${note.aliases.join(", ")}`);
    if (note.tags.length)
        lines.push(`tags: ${note.tags.join(", ")}`);
    for (const [k, v] of Object.entries(note.frontmatter)) {
        if (["title", "tags", "aliases", "alias"].includes(k))
            continue;
        lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
    }
    if (note.headings.length)
        lines.push("headings:", ...note.headings.map((h) => `  ${h}`));
    if (note.links.length) {
        lines.push("links:", ...note.links.map((l) => `  [[${l.target}${l.heading ? "#" + l.heading : ""}]]`));
    }
    return lines.join("\n");
}
// A section is its heading line plus everything up to the next heading of the
// same or higher level. Headings inside fenced code are not headings. Requests
// match a heading's text case-insensitively by prefix, so "Outcome Log"
// finds "## Outcome Log (pending first)". Sections come back in note order.
export function extractSections(markdown, wanted, maxLines) {
    const lines = markdown.split("\n");
    const headings = [];
    let fence = null;
    lines.forEach((line, i) => {
        const f = /^(```|~~~)/.exec(line);
        if (f)
            fence = fence === f[1] ? null : (fence ?? f[1]);
        if (fence)
            return;
        const h = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(line);
        if (h)
            headings.push({ line: i, level: h[1].length, text: h[2].trim() });
    });
    const norm = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();
    const picked = new Map();
    const missing = [];
    for (const w of wanted) {
        const exact = headings.findIndex((h) => norm(h.text) === norm(w));
        const idx = exact >= 0 ? exact : headings.findIndex((h) => norm(h.text).startsWith(norm(w)));
        if (idx < 0)
            missing.push(w);
        else
            picked.set(idx, headings[idx].text);
    }
    const order = [...picked.keys()].sort((a, b) => a - b);
    const blocks = order.map((idx) => {
        const h = headings[idx];
        const next = headings.slice(idx + 1).find((n) => n.level <= h.level);
        const end = next ? next.line : lines.length;
        const stop = maxLines === undefined ? end : Math.min(end, h.line + maxLines);
        return lines.slice(h.line, stop).join("\n").trimEnd();
    });
    return { content: blocks.join("\n\n") + (blocks.length ? "\n" : ""), found: order.map((i) => picked.get(i)), missing };
}
function stem(path) {
    return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}
