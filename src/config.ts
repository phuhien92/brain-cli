// Two configs, split by what may travel between machines.
//
// <vault>/brain.json — travels with the vault, identical everywhere:
//   { "log": { "dir": "log" },
//     "sync": "auto",                      // "auto" | "git" | "none" | { "command": "…" }
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

import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export interface ExportTarget {
  kind: string;
  path: string; // absolute, ~ expanded
  header?: string;
}

// How the vault's files reach other machines. brain never assumes one:
// "git" runs commit/pull/push (any remote: GitHub, GitLab, a bare repo);
// "none" means something else moves the files (iCloud, Dropbox, Syncthing,
// Obsidian Sync) and sync only refreshes and re-exports; a command runs
// whatever the user's setup needs; "auto" is git when the vault is a git
// repository, otherwise none.
export type SyncSpec = "auto" | "git" | "none" | { command: string };

export interface Integration {
  name: string;
  read: string[] | null; // vault-relative folder prefixes; null = the whole vault ("*")
  write: string[]; // log kinds it may add
  views: ExportTarget[]; // its views that have a path on this machine
}

export interface Config {
  logDir: string; // vault-relative, posix
  machine: string;
  exports: ExportTarget[]; // every view with a path on this machine, integrations' included
  sync: SyncSpec;
  integrations: Record<string, Integration>;
  as: Integration | null; // the integration this process acts as ($BRAIN_AS / --as)
  userConfigPath: string;
}

export class ConfigError extends Error {}

export function loadConfig(vault: string, opts: { as?: string } = {}): Config {
  const vaultCfg = readJson(join(vault, "brain.json")) ?? {};
  const userConfigPath = process.env.BRAIN_CONFIG || join(homedir(), ".config", "brain", "config.json");
  const userCfg = readJson(userConfigPath) ?? {};

  const logDir = String(objectAt(vaultCfg, "log").dir ?? "log")
    .replace(/\\/g, "/")
    .replace(/^\.?\/+|\/+$/g, "");
  if (!logDir || logDir.startsWith(".") || logDir.split("/").includes("..")) {
    throw new ConfigError(`brain.json: log.dir '${logDir}' must be a plain folder inside the vault`);
  }

  const machine = slug(process.env.BRAIN_MACHINE || String(userCfg.machine ?? "") || hostname().replace(/\.local$/i, ""));
  if (!machine) throw new ConfigError("could not derive a machine name: set BRAIN_MACHINE or 'machine' in the user config");

  const rawExports = userCfg.exports ?? [];
  if (!Array.isArray(rawExports)) throw new ConfigError(`${userConfigPath}: 'exports' must be a list`);
  const exports: ExportTarget[] = rawExports.map((e: unknown, i: number) => {
    const o = e as Record<string, unknown>;
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

  const integrations: Record<string, Integration> = {};
  const machineIntegrations = objectAt(userCfg, "integrations");
  for (const [rawName, rawSpec] of Object.entries(objectAt(vaultCfg, "integrations"))) {
    const name = slug(rawName);
    if (!name || name !== rawName) {
      throw new ConfigError(`brain.json: integration name '${rawName}' must be lowercase letters, digits and dashes`);
    }
    const spec = rawSpec && typeof rawSpec === "object" ? (rawSpec as Record<string, unknown>) : {};
    const read = stringList(spec.read, `brain.json: integrations.${name}.read`);
    const write = stringList(spec.write, `brain.json: integrations.${name}.write`).map(slug).filter(Boolean);
    const viewSpecs = objectAt(spec, "views");
    const viewPaths = objectAt(objectAt(machineIntegrations, name), "views");
    const views: ExportTarget[] = [];
    for (const [kind, path] of Object.entries(viewPaths)) {
      if (typeof path !== "string") throw new ConfigError(`${userConfigPath}: integrations.${name}.views.${kind} must be a path`);
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

  const asName = opts.as ?? process.env.BRAIN_AS ?? "";
  let as: Integration | null = null;
  if (asName) {
    as = integrations[asName] ?? null;
    if (!as) {
      const known = Object.keys(integrations);
      throw new ConfigError(
        `BRAIN_AS='${asName}' is not an integration in brain.json` + (known.length ? ` (known: ${known.join(", ")})` : ""),
      );
    }
  }

  return { logDir, machine, exports, sync, integrations, as, userConfigPath };
}

// What the acting integration may read: its declared folders plus the log
// folders of the kinds it writes. null means unrestricted (no BRAIN_AS, or "*").
export function readScope(cfg: Config): string[] | null {
  if (!cfg.as || cfg.as.read === null) return null;
  return [...cfg.as.read, ...cfg.as.write.map((k) => `${cfg.logDir}/${k}/`)];
}

export function inScope(path: string, scope: string[] | null): boolean {
  return scope === null || scope.some((prefix) => path.startsWith(prefix));
}

function parseSync(raw: unknown, source: string): SyncSpec {
  if (raw === "auto" || raw === "git" || raw === "none") return raw;
  if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).command === "string") {
    return { command: (raw as { command: string }).command };
  }
  throw new ConfigError(`${source}: 'sync' must be "auto", "git", "none" or { "command": "…" }`);
}

function stringList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ConfigError(`${where} must be a list of strings`);
  return v as string[];
}

function folderPrefix(p: string): string {
  const clean = p.replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
  if (!clean || clean.split("/").includes("..")) throw new ConfigError(`brain.json: read path '${p}' must be a folder inside the vault`);
  return clean + "/";
}

export function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

function expandHome(p: string): string {
  return resolve(p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(`${path}: invalid JSON (${(err as Error).message})`);
  }
  throw new ConfigError(`${path}: expected a JSON object`);
}

function objectAt(o: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = o[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
