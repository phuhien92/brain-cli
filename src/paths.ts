// Where brain keeps things. One resolver, so `brain path`, `brain doctor`, the
// index and telemetry can never disagree about a location. Nothing here creates
// a file or directory: these are names, not side effects.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Per machine, never in the vault: indexes and the telemetry queue.
export function stateRoot(): string {
  return process.env.BRAIN_STATE_DIR || join(homedir(), ".local", "state", "brain");
}

// This machine's config.
export function userConfigFile(): string {
  return process.env.BRAIN_CONFIG || join(homedir(), ".config", "brain", "config.json");
}

// One state directory per vault, named after it and its real path:
// "COWORK-OS-3f9a1c2b7d4e".
export function vaultStateDir(vault: string, root = stateRoot()): string {
  const name = vault.split(/[\\/]/).filter(Boolean).pop() ?? "vault";
  const id = createHash("sha256").update(vault).digest("hex").slice(0, 12);
  return join(root, `${name.replace(/[^A-Za-z0-9._-]+/g, "-")}-${id}`);
}

export const PATH_NAMES = ["vault", "log", "sources", "config", "user-config", "state", "index", "telemetry-queue"] as const;
export type PathName = (typeof PATH_NAMES)[number];


export function brainPaths(vault: string, logDir: string): Record<PathName, string> {
  const state = vaultStateDir(vault);
  return {
    vault,
    log: join(vault, logDir),
    sources: join(vault, "sources"),
    config: join(vault, "brain.json"),
    "user-config": userConfigFile(),
    state,
    index: join(state, "index.db"),
    "telemetry-queue": join(stateRoot(), "telemetry-queue.jsonl"),
  };
}

export function describePaths(paths: Record<PathName, string>): Record<PathName, { path: string; exists: boolean }> {
  return Object.fromEntries(PATH_NAMES.map((n) => [n, { path: paths[n], exists: existsSync(paths[n]) }])) as Record<
    PathName,
    { path: string; exists: boolean }
  >;
}
