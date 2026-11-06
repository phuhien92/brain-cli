// `brain log` (list, add, import, retire, replace) and `brain export`, plus the
// helpers they share with other commands.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inReadScope, inScope, slug } from "../config.js";
import { redactor } from "../feedback.js";
import { dispatchLogAddedHooks } from "../hooks.js";
import { addEntry, addEntryOnce, exportView, importFile, LIFECYCLE_KIND, listEntries, recordRetirement } from "../log.js";
import { CliError } from "./shared.js";
export const logCommand = async (args, flags, ctx) => {
    const { out, print } = ctx;
    const { vault, cfg, scope, permit, store } = ctx.vault;
    let index = ctx.vault.index;
    const command = "log";
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
        if (result.added)
            dispatchLogAddedHooks(store, cfg, [result.path]);
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
        dispatchLogAddedHooks(store, cfg, result.added);
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
        dispatchLogAddedHooks(store, cfg, [replacement]);
        return 0;
    }
    const n = sub === undefined ? 10 : Number(sub);
    if (!Number.isInteger(n) || n < 1 || rest.length) {
        throw new CliError("usage", "usage: brain log [n] [--kind k] | log add <kind> <title> | log import <kind> <file> | log retire <entry-id> | log replace <entry-id> --text <title> [--body <text>]", 2);
    }
    const entries = listEntries(store, cfg, { kind: flags.kind ? slug(flags.kind) : undefined, limit: scope ? -1 : n })
        .filter((e) => inReadScope(store, cfg, e.path, scope))
        .slice(0, n);
    print(out, "log", { entries }, { vault, index }, () => entries.length
        ? entries.map((e) => `${e.created.slice(0, 10)}  ${e.kind.padEnd(10)} ${e.machine.padEnd(12)} ${e.title}`).join("\n")
        : "no entries yet — add one with: brain log add <kind> <title>");
    return 0;
};
export const exportCommand = (_args, flags, ctx) => {
    const { out, print } = ctx;
    const { vault, cfg, store, index } = ctx.vault;
    const command = "export";
    const exports = runExports(store, cfg, flags.force);
    const drift = exports.filter((e) => e.status === "drift");
    if (drift.length) {
        if (!out.json && !out.quiet)
            process.stdout.write(formatExports(exports) + "\n");
        throw new CliError("export_drift", driftMessage(drift), 5, { exports });
    }
    print(out, command, { exports }, { vault, index }, () => formatExports(exports) || "no exports configured");
    return 0;
};
export function runExports(store, cfg, force) {
    const targets = cfg.as ? cfg.as.views : cfg.exports;
    return targets.map((target) => exportView(store, cfg, target, force));
}
export function resolveLogEntry(store, cfg, ref, scope) {
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
export function formatExports(exports) {
    return exports.map((e) => `export ${e.kind} → ${e.path}: ${e.status} (${e.entries} entries)`).join("\n");
}
export function driftMessage(drift) {
    return (`${drift.map((d) => d.path).join(", ")} changed since brain last wrote it. ` +
        `Capture those edits first (brain log import <kind> <file>), then run brain export --force.`);
}
