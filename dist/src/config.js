// Two configs, split by what may travel between machines.
//
// <vault>/brain.json — travels with the vault, identical everywhere:
//   { "log": { "dir": "log" },
//     "sync": "auto",                      // "auto" | "git" | "none" | { "command": "…" }
//     "lifecycle": { "windows": { "current-state": 30 } },   // review windows in days
//     "lint": { "maxLines": { "MEMORY.md": 150 }, "unsourced": ["Research/"] },
//     "integrations": {                    // one block per repo/tool that uses the vault
//       "firstmate": { "read": ["firstmate/"], "write": ["learning"],
//                      "views": { "learning": { "header": "<!-- memory tiers: see the stow skill -->" } } } } }
//
// ~/.config/brain/config.json ($BRAIN_CONFIG) — machine-local, never synced,
// because it names this machine and paths that only exist on it:
//   { "machine": "mac-mini",
//     "sync": "none",                      // optional per-machine override
//     "integrations": { "firstmate": { "views": { "learning": "~/firstmate/data/learnings.md" } } },
//     "exports": [{ "kind": "…", "path": "…" }] }   // views not tied to an integration
//
// Adding a repo is configuration, never code: a block in brain.json, its
// paths on each machine, and BRAIN_AS=<name> in that repo's agent environment.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { enabledExtensionNames, installedManifest } from "./extensions.js";
import { userConfigFile } from "./paths.js";
export { userConfigFile };
export class ConfigError extends Error {
}
export function loadConfig(vault, opts = {}) {
    const vaultCfg = readJson(join(vault, "brain.json")) ?? {};
    const userConfigPath = userConfigFile();
    const userCfg = readJson(userConfigPath) ?? {};
    const logDir = String(objectAt(vaultCfg, "log").dir ?? "log")
        .replace(/\\/g, "/")
        .replace(/^\.?\/+|\/+$/g, "");
    if (!logDir || logDir.startsWith(".") || logDir.split("/").includes("..")) {
        throw new ConfigError(`brain.json: log.dir '${logDir}' must be a plain folder inside the vault`);
    }
    const machine = slug(process.env.BRAIN_MACHINE || String(userCfg.machine ?? "") || hostname().replace(/\.local$/i, ""));
    if (!machine)
        throw new ConfigError("could not derive a machine name: set BRAIN_MACHINE or 'machine' in the user config");
    const rawExports = userCfg.exports ?? [];
    if (!Array.isArray(rawExports))
        throw new ConfigError(`${userConfigPath}: 'exports' must be a list`);
    const exports = rawExports.map((e, i) => {
        const o = e;
        if (!o || typeof o.kind !== "string" || typeof o.path !== "string") {
            throw new ConfigError(`${userConfigPath}: exports[${i}] needs a 'kind' and a 'path'`);
        }
        return {
            kind: slug(o.kind),
            path: expandHome(o.path),
            header: typeof o.header === "string" ? o.header : undefined,
        };
    });
    const sync = parseSync(userCfg.sync ?? vaultCfg.sync ?? "auto", userCfg.sync !== undefined ? userConfigPath : "brain.json");
    const integrations = {};
    const machineIntegrations = objectAt(userCfg, "integrations");
    for (const [rawName, rawSpec] of Object.entries(objectAt(vaultCfg, "integrations"))) {
        const name = slug(rawName);
        if (!name || name !== rawName) {
            throw new ConfigError(`brain.json: integration name '${rawName}' must be lowercase letters, digits and dashes`);
        }
        const spec = rawSpec && typeof rawSpec === "object" ? rawSpec : {};
        const read = stringList(spec.read, `brain.json: integrations.${name}.read`);
        const write = stringList(spec.write, `brain.json: integrations.${name}.write`).map(slug).filter(Boolean);
        const viewSpecs = objectAt(spec, "views");
        const viewPaths = objectAt(objectAt(machineIntegrations, name), "views");
        const views = [];
        for (const [kind, path] of Object.entries(viewPaths)) {
            if (typeof path !== "string")
                throw new ConfigError(`${userConfigPath}: integrations.${name}.views.${kind} must be a path`);
            const header = objectAt(viewSpecs, kind).header;
            views.push({ kind: slug(kind), path: expandHome(path), header: typeof header === "string" ? header : undefined });
        }
        integrations[name] = {
            name,
            read: read.includes("*") ? null : read.map(folderPrefix),
            write,
            views,
        };
        exports.push(...views);
    }
    for (const name of Object.keys(machineIntegrations)) {
        if (!integrations[name]) {
            throw new ConfigError(`${userConfigPath}: integration '${name}' is not declared in the vault's brain.json`);
        }
    }
    let enabledExtensions;
    try {
        enabledExtensions = enabledExtensionNames(vault);
    }
    catch (err) {
        throw new ConfigError(err.message);
    }
    const asName = opts.as ?? process.env.BRAIN_AS ?? "";
    let as = null;
    const extensionName = process.env.BRAIN_EXTENSION_SCOPE ?? "";
    if (extensionName) {
        if (!enabledExtensions.includes(extensionName)) {
            throw new ConfigError(`extension '${extensionName}' is not enabled for this vault`);
        }
        let installed;
        try {
            installed = installedManifest(extensionName);
        }
        catch (err) {
            throw new ConfigError(err.message);
        }
        if (!installed)
            throw new ConfigError(`extension '${extensionName}' is not installed on this machine`);
        const extension = extensionIntegration(installed.manifest);
        const parentName = process.env.BRAIN_EXTENSION_PARENT_AS ?? "";
        if (parentName) {
            const parent = integrations[parentName];
            if (!parent) {
                const known = Object.keys(integrations);
                throw new ConfigError(`BRAIN_AS='${parentName}' is not an integration in brain.json` + (known.length ? ` (known: ${known.join(", ")})` : ""));
            }
            as = intersectIntegrations(parent, extension, logDir);
        }
        else {
            as = extension;
        }
    }
    else if (asName) {
        as = integrations[asName] ?? null;
        if (!as) {
            const known = Object.keys(integrations);
            throw new ConfigError(`BRAIN_AS='${asName}' is not an integration in brain.json` + (known.length ? ` (known: ${known.join(", ")})` : ""));
        }
    }
    const lifecycleWindows = {};
    for (const [cat, days] of Object.entries(objectAt(objectAt(vaultCfg, "lifecycle"), "windows"))) {
        if (days !== null && !(typeof days === "number" && Number.isInteger(days) && days > 0)) {
            throw new ConfigError(`brain.json: lifecycle.windows.${cat} must be a positive number of days or null`);
        }
        lifecycleWindows[cat] = days;
    }
    const lintCfg = objectAt(vaultCfg, "lint");
    const lintMaxLines = {};
    for (const [path, n] of Object.entries(objectAt(lintCfg, "maxLines"))) {
        if (!(typeof n === "number" && Number.isInteger(n) && n > 0)) {
            throw new ConfigError(`brain.json: lint.maxLines["${path}"] must be a positive integer`);
        }
        lintMaxLines[path] = n;
    }
    const lintUnsourced = stringList(lintCfg.unsourced, "brain.json: lint.unsourced").map(folderPrefix);
    return { logDir, machine, exports, sync, integrations, as, lifecycleWindows, lintMaxLines, lintUnsourced, userConfigPath };
}
// What the acting integration may read: its declared folders plus the log
// folders of the kinds it writes. null means unrestricted (no BRAIN_AS, or "*").
export function readScope(cfg) {
    if (!cfg.as || cfg.as.read === null)
        return null;
    return [...cfg.as.read, ...cfg.as.write.map((k) => `${cfg.logDir}/${k}/`)];
}
export function inScope(path, scope) {
    return scope === null || scope.some((prefix) => path.startsWith(prefix));
}
export function inReadScope(store, cfg, path, scope = readScope(cfg)) {
    if (scope === null)
        return true;
    if (!inScope(path, scope))
        return false;
    const lifecyclePrefix = `${cfg.logDir}/lifecycle/`;
    let target = path;
    const seen = new Set();
    while (target.startsWith(lifecyclePrefix)) {
        if (seen.has(target))
            return false;
        seen.add(target);
        const next = store.get(target)?.frontmatter.target;
        if (typeof next !== "string")
            return false;
        target = next;
    }
    return inScope(target, scope);
}
function extensionIntegration(manifest) {
    return {
        name: manifest.name,
        read: manifest.permissions.read.includes("*") ? null : manifest.permissions.read,
        write: manifest.permissions.write,
        views: [],
    };
}
function integrationScope(integration, logDir) {
    if (integration.read === null)
        return null;
    return [...integration.read, ...integration.write.map((kind) => `${logDir}/${kind}/`)];
}
// A command launched from an already scoped integration gets the intersection
// of that scope and the extension manifest. An extension can narrow a caller,
// never use its own permissions to widen one.
function intersectIntegrations(parent, extension, logDir) {
    const a = integrationScope(parent, logDir);
    const b = integrationScope(extension, logDir);
    let read;
    if (a === null)
        read = b;
    else if (b === null)
        read = a;
    else {
        read = [...new Set(a.flatMap((left) => b.flatMap((right) => {
                if (left.startsWith(right))
                    return [left];
                if (right.startsWith(left))
                    return [right];
                return [];
            })))];
    }
    return {
        name: extension.name,
        read,
        write: extension.write.filter((kind) => parent.write.includes(kind)),
        views: [],
    };
}
function parseSync(raw, source) {
    if (raw === "auto" || raw === "git" || raw === "none")
        return raw;
    if (raw && typeof raw === "object" && typeof raw.command === "string") {
        return { command: raw.command };
    }
    throw new ConfigError(`${source}: 'sync' must be "auto", "git", "none" or { "command": "…" }`);
}
function stringList(v, where) {
    if (v === undefined)
        return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
        throw new ConfigError(`${where} must be a list of strings`);
    return v;
}
function folderPrefix(p) {
    const clean = p.replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
    if (!clean || clean.split("/").includes(".."))
        throw new ConfigError(`brain.json: read path '${p}' must be a folder inside the vault`);
    return clean + "/";
}
export function userSettings() {
    const path = userConfigFile();
    let cfg = {};
    try {
        cfg = readJson(path) ?? {};
    }
    catch {
        cfg = {};
    }
    const post = objectAt(cfg, "feedback").post;
    return {
        telemetry: typeof cfg.telemetry === "boolean" ? cfg.telemetry : null,
        feedbackPost: post === "allow" ? "allow" : "ask",
    };
}
export function readUserConfig() {
    return readJson(userConfigFile()) ?? {};
}
// Merge keys into this machine's config, keeping everything else, atomically.
export function writeUserConfig(patch) {
    const path = userConfigFile();
    const next = { ...readUserConfig(), ...patch };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, path);
    return path;
}
export function slug(s) {
    return s
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)
        .replace(/-+$/, "");
}
function expandHome(p) {
    return resolve(p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
}
function readJson(path) {
    if (!existsSync(path))
        return null;
    try {
        const v = JSON.parse(readFileSync(path, "utf8"));
        if (v && typeof v === "object" && !Array.isArray(v))
            return v;
    }
    catch (err) {
        throw new ConfigError(`${path}: invalid JSON (${err.message})`);
    }
    throw new ConfigError(`${path}: expected a JSON object`);
}
function objectAt(o, key) {
    const v = o[key];
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
