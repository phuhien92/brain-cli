import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig, readScope, readUserConfig, userSettings } from "./config.js";
import { saveLastError, } from "./feedback.js";
import * as telemetry from "./telemetry.js";
import * as update from "./update.js";
import { OfflineNoteError, Store } from "./store.js";
import { SyncError } from "./sync.js";
import { ExtensionError, publicExtensionSource, } from "./extensions.js";
import { CliError, parseFlags } from "./commands/shared.js";
import { HELP } from "./commands/help.js";
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
import { setupHandler } from "./commands/setup.js";
import { telemetryCommand } from "./commands/telemetry.js";
import { feedbackHandler } from "./commands/feedback.js";
import { agentCommand } from "./commands/agent.js";
import { contextCommand } from "./commands/context.js";
import { updateCommand } from "./commands/update.js";
export { extractSections } from "./commands/format.js";
export const VERSION = "0.12.0";
// Bumped only on a breaking change to the --json envelope or a command's data shape.
export const SCHEMA = "brain.v1";
// Telemetry records a command by a name from these lists only (COMMANDS is
// built from the router tables below). Anything else a user typed (a query, a
// note, feedback text) can never become a name.
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
    setup: setupHandler,
    telemetry: { handler: telemetryCommand, failAs: byTelemetryName },
    feedback: { handler: feedbackHandler, failAs: byTelemetryName },
    agent: { handler: agentCommand, failAs: () => "agent.install" },
    // Never fails: it catches everything itself (CLAUDE.md invariant 11).
    context: contextCommand,
    update: updateCommand,
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
// Every built-in command, from the two tables: one list to change, not three.
const COMMANDS = [...Object.keys(EARLY), ...Object.keys(VAULT), "help"];
const BUILT_INS = new Set(COMMANDS);
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
