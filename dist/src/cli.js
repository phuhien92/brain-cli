import { existsSync, realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig, readScope, readUserConfig, slug, userSettings } from "./config.js";
import { applySetup, detectHarnesses, findVaultCandidates, interactiveSetup, recommendSync } from "./setup.js";
import { createDraft, diagnostics, getDraft, issueUrl, KINDS, lastError, listDrafts, markSubmitted, postWithGh, redactor, repo, saveLastError, } from "./feedback.js";
import * as telemetry from "./telemetry.js";
import * as update from "./update.js";
import { context, HARNESSES, install } from "./agent.js";
import { contextHookLines } from "./hooks.js";
import { OfflineNoteError, Store } from "./store.js";
import { PATH_NAMES } from "./paths.js";
import { SyncError } from "./sync.js";
import { ExtensionError, publicExtensionSource, } from "./extensions.js";
import { CliError, parseFlags } from "./commands/shared.js";
import { pathCommand } from "./commands/path.js";
import { viewCommand } from "./commands/view.js";
import { extensionManagementCommand, runExtensionCommand } from "./commands/ext.js";
import { exportCommand, logCommand } from "./commands/log.js";
import { ingestCommand } from "./commands/ingest.js";
import { indexCommand } from "./commands/index.js";
import { searchCommand } from "./commands/search.js";
import { getCommand } from "./commands/get.js";
import { syncCommand } from "./commands/sync.js";
import { lifecycleCommand } from "./commands/lifecycle.js";
import { lintCommand } from "./commands/lint.js";
import { integrationsCommand } from "./commands/integrations.js";
import { doctorCommand } from "./commands/doctor.js";
export { extractSections } from "./commands/format.js";
export const VERSION = "0.12.0";
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
                              --telemetry yes|no, --update-check yes|no, --profile

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
  update [--check]            Is a newer brain released? Prints the install command.
                              --check asks GitHub now; otherwise brain checks once a day in
                              the background (off: BRAIN_NO_UPDATE_CHECK=1). Never self-updates

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
// Telemetry records a command by a name from these lists only. Anything else
// a user typed (a query, a note, feedback text) can never become a name.
const COMMANDS = ["setup", "index", "search", "get", "ingest", "log", "view", "export", "sync", "integrations", "doctor", "path", "lifecycle", "lint", "context", "agent", "feedback", "telemetry", "update", "ext", "help"];
const BUILT_INS = new Set(COMMANDS);
const EXTENSION_CHILD_COMMANDS = new Set(["help", "search", "get", "log", "view", "lifecycle"]);
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
const byTelemetryName = (_command, named) => named;
// Look up only a table's own entries: a command named "constructor" or
// "__proto__" must be unknown, not an inherited property.
function route(table, command) {
    return Object.hasOwn(table, command) ? table[command] : undefined;
}
const EARLY = {
    path: pathCommand,
    ext: { handler: (args, flags, ctx) => extensionManagementCommand(args, flags, ctx), failAs: byTelemetryName },
};
const VAULT = {
    ingest: ingestCommand,
    index: indexCommand,
    search: searchCommand,
    get: getCommand,
    log: logCommand,
    view: viewCommand,
    export: exportCommand,
    sync: syncCommand,
    integrations: integrationsCommand,
    doctor: doctorCommand,
    lifecycle: lifecycleCommand,
    lint: lintCommand,
};
/** The context the router hands every handler. */
function makeCtx(out) {
    return {
        out,
        print,
        schema: SCHEMA,
        version: VERSION,
        bin: BIN,
        findVault,
        report: (r) => {
            if (r.context)
                tContext = r.context;
            if (r.error)
                tError = r.error;
        },
    };
}
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
    const settings = userSettings();
    const line = update.notice({
        version: VERSION,
        configCheck: settings.updateCheck,
        json,
        quiet: argv.includes("--quiet") || argv.includes("-q"),
        command: tCommand,
    });
    if (line)
        process.stderr.write(`\n${line}\n`);
    update.maybeCheck(settings.updateCheck, BIN);
    // Managing telemetry is not usage of brain, and neither is brain's own
    // background work; neither is ever recorded.
    if (!tCommand.startsWith("telemetry") && !process.env.BRAIN_BACKGROUND) {
        telemetry.record({ command: tCommand, exit, error: tError, ms: Date.now() - started, json: argv.includes("--json"), version: VERSION }, tContext, settings.telemetry, BIN);
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
            return await runExtensionCommand(leading, [...argv.slice(position + 1), ...argv.slice(0, position)], makeCtx(out));
        }
        catch (err) {
            return fail(out, leading, err);
        }
    }
    let parsed;
    try {
        parsed = parseFlags(argv);
    }
    catch (err) {
        const json = argv.includes("--json");
        return fail({ json, quiet: false }, "unknown", new CliError("usage", err.message, 2));
    }
    const { values: flags, positionals } = parsed;
    const out = { json: flags.json ?? false, quiet: flags.quiet ?? false };
    const [command = "help", ...args] = positionals;
    tCommand = telemetryName(command, args[0]);
    const ctx = makeCtx(out);
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
            const text = context(ctxStore, cfg, limit, await contextHookLines(vault, cfg));
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
    if (command === "update") {
        try {
            if (args.length)
                throw new CliError("usage", "usage: brain update [--check]", 2);
            const configCheck = userSettings().updateCheck;
            let error = null;
            if (flags.check)
                error = (await update.check(VERSION)).error;
            const st = update.status(VERSION, configCheck);
            print(out, command, { ...st, error }, null, () => [
                st.available
                    ? `brain ${st.latest} is available (you have ${st.current}). Update with:\n  ${st.command}`
                    : st.latest
                        ? `brain ${st.current} is the latest release.`
                        : `brain ${st.current}. No release has been checked yet${flags.check ? "" : ": run brain update --check"}.`,
                ...(error ? [`check failed: ${error}`] : []),
                st.checkedAt ? `last checked ${st.checkedAt.slice(0, 10)}` : "",
                st.enabled ? "" : `daily check off (${st.reason})`,
            ]
                .filter(Boolean)
                .join("\n"));
            return 0;
        }
        catch (err) {
            return fail(out, command, err);
        }
    }
    const early = route(EARLY, command);
    if (early) {
        const handler = typeof early === "function" ? early : early.handler;
        try {
            return await handler(args, flags, ctx);
        }
        catch (err) {
            return fail(out, typeof early === "function" ? command : early.failAs(command, tCommand), err);
        }
    }
    let store = null;
    try {
        const handler = route(VAULT, command);
        if (!handler) {
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
        const index = store.refresh({ verify: command === "index" && flags.verify });
        tContext = {
            notes: store.count(),
            sync: typeof cfg.sync === "object" ? "command" : cfg.sync,
            integrations: Object.keys(cfg.integrations).length,
            scoped: !!cfg.as,
        };
        ctx.vault = { vault, cfg, scope, permit, store, index };
        return await handler(args, flags, ctx);
    }
    catch (err) {
        return fail(out, command, err);
    }
    finally {
        store?.close();
    }
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
        const u = flags["update-check"];
        if (u !== undefined && !["yes", "no"].includes(u))
            throw new CliError("usage", "--update-check must be yes or no", 2);
        const machine = slug(flags.machine ?? String(readUserConfig().machine ?? "")) || slug(hostname().replace(/\.local$/i, ""));
        choices = {
            vault,
            machine,
            sync: sync,
            agents: agents,
            telemetry: t === undefined ? null : t === "yes",
            updateCheck: u === undefined ? null : u === "yes",
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
// Each check names what it found and, when it warns, what to do. Nothing here
// changes anything: doctor only reads.
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
// A section is its heading line plus everything up to the next heading of the
// same or higher level. Headings inside fenced code are not headings. Requests
// match a heading's text case-insensitively by prefix, so "Outcome Log"
// finds "## Outcome Log (pending first)". Sections come back in note order.
