// Two configs, split by what may travel between machines.
//
// <vault>/brain.json — committed with the vault, identical everywhere:
//   { "log": { "dir": "log" } }
//
// ~/.config/brain/config.json ($BRAIN_CONFIG) — machine-local, never synced,
// because it names this machine and paths that only exist on it:
//   { "machine": "mac-mini",
//     "exports": [{ "kind": "learning", "path": "~/firstmate/data/learnings.md",
//                   "header": "<!-- memory tiers: see the stow skill -->" }] }

import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export interface ExportTarget {
  kind: string;
  path: string; // absolute, ~ expanded
  header?: string;
}

export interface Config {
  logDir: string; // vault-relative, posix
  machine: string;
  exports: ExportTarget[];
  userConfigPath: string;
}

export class ConfigError extends Error {}

export function loadConfig(vault: string): Config {
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
  const exports = rawExports.map((e: unknown, i: number) => {
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

  return { logDir, machine, exports, userConfigPath };
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
