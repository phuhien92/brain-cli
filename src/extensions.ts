// Kind-1 extensions are installed machine-locally and run as separate
// processes. The manifest is the public contract; no extension code is ever
// loaded into brain's process.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { extensionsRoot } from "./paths.js";

export interface ExtensionPermissions {
  read: string[];
  write: string[];
  network: string[];
}

export interface ExtensionManifest {
  name: string;
  version: string;
  brain?: string;
  description?: string;
  command: string;
  permissions: ExtensionPermissions;
}

interface InstallMetadata {
  source: string;
  commit: string | null;
}

export interface ExtensionRecord {
  name: string;
  installed: boolean;
  enabled: boolean;
  directory: string | null;
  manifest: ExtensionManifest | null;
  source: string | null;
  commit: string | null;
  error: string | null;
}

export class ExtensionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exit = 1,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const MANIFEST = "brain-extension.json";
const METADATA = ".brain-install.json";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const RESERVED = new Set([
  "setup", "index", "search", "get", "log", "view", "export", "sync", "lifecycle", "lint",
  "integrations", "doctor", "path", "context", "agent", "feedback", "telemetry", "ext", "help",
]);

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExtensionError("invalid_manifest", `${where} must be an object`, 2);
  return value as Record<string, unknown>;
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ExtensionError("invalid_manifest", `${where} must be a list of strings`, 2);
  }
  return [...new Set(value as string[])];
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function readManifest(directory: string): ExtensionManifest {
  const path = join(directory, MANIFEST);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ExtensionError("invalid_manifest", `${path}: ${(err as Error).message}`, 2);
  }
  const o = object(raw, path);
  const name = typeof o.name === "string" ? o.name : "";
  if (!name || slug(name) !== name) {
    throw new ExtensionError("invalid_manifest", `${path}: name must be lowercase letters, digits and dashes`, 2);
  }
  const version = typeof o.version === "string" ? o.version.trim() : "";
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ExtensionError("invalid_manifest", `${path}: version must be semver (for example 1.2.3)`, 2);
  }
  const command = typeof o.command === "string" ? o.command.replace(/\\/g, "/") : "";
  if (!command || isAbsolute(command) || command.split("/").some((p) => !p || p === "." || p === "..")) {
    throw new ExtensionError("invalid_manifest", `${path}: command must be a relative path inside the extension`, 2);
  }
  if (RESERVED.has(name)) {
    throw new ExtensionError("invalid_manifest", `${path}: '${name}' is a built-in command and cannot be replaced`, 2);
  }
  const p = object(o.permissions, `${path}: permissions`);
  const read = strings(p.read, `${path}: permissions.read`).map((folder) => {
    if (CONTROL_CHARACTERS.test(folder)) {
      throw new ExtensionError("invalid_manifest", `${path}: permission read paths cannot contain control characters`, 2);
    }
    if (folder === "*") return folder;
    const clean = folder.replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
    if (!clean || clean.split("/").includes("..")) {
      throw new ExtensionError("invalid_manifest", `${path}: permission read path '${folder}' must be a folder inside the vault`, 2);
    }
    return `${clean}/`;
  });
  const write = strings(p.write, `${path}: permissions.write`).map((kind) => {
    if (!kind || slug(kind) !== kind) {
      throw new ExtensionError("invalid_manifest", `${path}: permission write kind '${kind}' must be lowercase letters, digits and dashes`, 2);
    }
    return kind;
  });
  const network = strings(p.network, `${path}: permissions.network`);
  for (const host of network) {
    if (!/^(?:\*\.)?[A-Za-z0-9.-]+(?::\d+)?$/.test(host) || host.includes("..")) {
      throw new ExtensionError("invalid_manifest", `${path}: network permission '${host}' must be a host name, not a URL`, 2);
    }
  }
  const brain = o.brain === undefined ? undefined : typeof o.brain === "string" ? o.brain : null;
  const description = o.description === undefined ? undefined : typeof o.description === "string" ? o.description.trim() : null;
  if (brain === null || description === null) throw new ExtensionError("invalid_manifest", `${path}: brain and description must be strings`, 2);
  if (description && CONTROL_CHARACTERS.test(description)) {
    throw new ExtensionError("invalid_manifest", `${path}: description cannot contain control characters`, 2);
  }

  const manifest: ExtensionManifest = {
    name,
    version,
    command,
    permissions: { read, write, network },
  };
  if (brain !== undefined) manifest.brain = brain;
  if (description !== undefined && description) manifest.description = description;
  return manifest;
}

// Launcher convention: manifests use one platform-neutral path. Unix runs it
// verbatim; Windows resolves an extensionless path to .exe first, then .cmd.
export function resolveLauncher(directory: string, manifest: ExtensionManifest, platform = process.platform): string {
  const base = resolve(directory, ...manifest.command.split("/"));
  if (!inside(resolve(directory), base)) throw new ExtensionError("invalid_manifest", "extension command escapes its directory", 2);
  const candidates = platform === "win32" && !extname(base) ? [`${base}.exe`, `${base}.cmd`] : [base];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    const wanted = candidates.map((p) => relative(directory, p)).join(" or ");
    throw new ExtensionError("invalid_manifest", `${MANIFEST}: command not found (${wanted})`, 2);
  }
  const realRoot = realpathSync(directory);
  const real = realpathSync(found);
  if (!inside(realRoot, real)) throw new ExtensionError("invalid_manifest", "extension command resolves outside its directory", 2);
  if (!statSync(real).isFile()) throw new ExtensionError("invalid_manifest", "extension command is not a file", 2);
  if (platform !== "win32") {
    try {
      accessSync(real, constants.X_OK);
    } catch {
      throw new ExtensionError("invalid_manifest", `${relative(directory, found)} is not executable`, 2);
    }
  }
  return found;
}

export interface ExtensionProcess {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

// .cmd launchers require cmd.exe. Quote using cmd's two parsing layers rather
// than `shell: true`, which would interpolate extension arguments.
export function extensionProcess(launcher: string, args: string[], platform = process.platform): ExtensionProcess {
  if (platform !== "win32" || extname(launcher).toLowerCase() !== ".cmd") return { file: launcher, args };
  const meta = /([()%!^"<>&|])/g;
  const escapeCommand = (value: string) => value.replace(meta, "^$1");
  const escapeArgument = (value: string) => {
    let escaped = value.replace(/(?=(\\+?))\1"/g, "$1$1\\\"");
    escaped = escaped.replace(/(?=(\\+?))\1$/g, "$1$1");
    return `"${escaped}"`.replace(meta, "^$1");
  };
  const command = [escapeCommand(launcher), ...args.map(escapeArgument)].join(" ");
  return {
    file: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", `"${command}"`],
    windowsVerbatimArguments: true,
  };
}

export function extensionDirectory(name: string): string {
  if (!name || slug(name) !== name) throw new ExtensionError("usage", `invalid extension name '${name}'`, 2);
  return join(extensionsRoot(), name);
}

export function installedManifest(name: string): { directory: string; manifest: ExtensionManifest } | null {
  const directory = extensionDirectory(name);
  if (!existsSync(directory)) return null;
  const manifest = readManifest(directory);
  if (manifest.name !== name) throw new ExtensionError("invalid_manifest", `${MANIFEST}: expected name '${name}', found '${manifest.name}'`, 2);
  resolveLauncher(directory, manifest);
  return { directory, manifest };
}

function readVaultJson(vault: string): Record<string, unknown> {
  const path = join(vault, "brain.json");
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return object(value, path);
  } catch (err) {
    if (err instanceof ExtensionError) throw err;
    throw new ExtensionError("config", `${path}: invalid JSON (${(err as Error).message})`);
  }
}

export function enabledExtensionNames(vault: string): string[] {
  const directory = enablementDirectory(vault);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.slice(0, -3))
    .filter((name) => slug(name) === name)
    .sort();
}

function enablementDirectory(vault: string): string {
  const cfg = readVaultJson(vault);
  const raw = (cfg.log === undefined ? {} : object(cfg.log, "brain.json: log")).dir ?? "log";
  const logDir = String(raw).replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
  if (!logDir || logDir.startsWith(".") || logDir.split("/").includes("..")) {
    throw new ExtensionError("config", `brain.json: log.dir '${logDir}' must be a plain folder inside the vault`);
  }
  return join(vault, ...logDir.split("/"), "extensions");
}

function enable(vault: string, name: string): void {
  const directory = enablementDirectory(vault);
  const path = join(directory, `${name}.md`);
  if (existsSync(path)) return;
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(path, `---\nkind: extension\nextension: ${name}\n---\n# ${name}\n`, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

function gitSource(source: string): string | null {
  return /^(?:https?|ssh|git|file):\/\//.test(source) || /^[^@\s]+@[^:\s]+:.+/.test(source) ? source : null;
}

function prepare(source: string, stage: string): InstallMetadata {
  const git = gitSource(source);
  if (git) {
    try {
      execFileSync("git", ["clone", "--quiet", "--depth", "1", "--", git, stage], { stdio: ["ignore", "pipe", "pipe"] });
      const commit = execFileSync("git", ["-C", stage, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      rmSync(join(stage, ".git"), { recursive: true, force: true });
      return { source, commit };
    } catch (err) {
      const detail = (err as { stderr?: Buffer | string }).stderr?.toString().trim().split("\n").at(-1);
      throw new ExtensionError("install_failed", `could not clone ${source}${detail ? `: ${detail}` : ""}`);
    }
  }
  const local = resolve(source);
  if (!existsSync(local) || !statSync(local).isDirectory()) {
    throw new ExtensionError("not_found", `extension source '${source}' is not a directory or git URL`, 3);
  }
  if (inside(resolve(extensionsRoot()), realpathSync(local))) {
    throw new ExtensionError("usage", "install from the extension's source directory, not the managed installation directory", 2);
  }
  cpSync(local, stage, { recursive: true, filter: (p) => p === local || p.split(/[\\/]/).at(-1) !== ".git" });
  return { source: realpathSync(local), commit: null };
}

export async function installExtension(
  source: string,
  vault: string,
  confirm: (manifest: ExtensionManifest) => Promise<boolean>,
): Promise<{ installed: boolean; enabled: boolean; directory: string | null; manifest: ExtensionManifest }> {
  if (!source) throw new ExtensionError("usage", "usage: brain ext install <path|git-url>", 2);
  const root = extensionsRoot();
  mkdirSync(root, { recursive: true });
  const stage = join(root, `.install-${process.pid}-${randomUUID()}`);
  let destination: string | null = null;
  try {
    const metadata = prepare(source, stage);
    const manifest = readManifest(stage);
    resolveLauncher(stage, manifest);
    destination = extensionDirectory(manifest.name);
    if (existsSync(destination)) {
      const current = installedManifest(manifest.name)!;
      if (JSON.stringify(current.manifest) !== JSON.stringify(manifest)) {
        throw new ExtensionError(
          "install_conflict",
          `extension '${manifest.name}' is already installed with a different manifest; remove it before reinstalling`,
          5,
        );
      }
      if (!(await confirm(current.manifest))) return { installed: false, enabled: false, directory: null, manifest: current.manifest };
      enable(vault, manifest.name);
      return { installed: true, enabled: true, directory: current.directory, manifest: current.manifest };
    }
    if (!(await confirm(manifest))) return { installed: false, enabled: false, directory: null, manifest };
    writeFileSync(join(stage, METADATA), JSON.stringify(metadata, null, 2) + "\n", { flag: "wx" });
    renameSync(stage, destination);
    try {
      enable(vault, manifest.name);
    } catch (err) {
      rmSync(destination, { recursive: true, force: true });
      throw err;
    }
    return { installed: true, enabled: true, directory: destination, manifest };
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

export function listExtensions(vault: string): ExtensionRecord[] {
  const enabled = enabledExtensionNames(vault);
  const names = new Set(enabled);
  const root = extensionsRoot();
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".install-")) names.add(entry.name);
    }
  }
  return [...names].sort().map((name) => {
    const directory = join(root, name);
    if (!existsSync(directory)) {
      return { name, installed: false, enabled: enabled.includes(name), directory: null, manifest: null, source: null, commit: null, error: "not installed on this machine" };
    }
    try {
      const manifest = readManifest(directory);
      resolveLauncher(directory, manifest);
      let metadata: Partial<InstallMetadata> = {};
      try {
        metadata = JSON.parse(readFileSync(join(directory, METADATA), "utf8")) as Partial<InstallMetadata>;
      } catch {
        // A broken metadata file does not hide an otherwise usable extension.
      }
      return {
        name,
        installed: true,
        enabled: enabled.includes(name),
        directory,
        manifest,
        source: typeof metadata.source === "string" ? metadata.source : null,
        commit: typeof metadata.commit === "string" ? metadata.commit : null,
        error: manifest.name === name ? null : `manifest name is '${manifest.name}'`,
      };
    } catch (err) {
      return { name, installed: true, enabled: enabled.includes(name), directory, manifest: null, source: null, commit: null, error: (err as Error).message };
    }
  });
}

export function removeExtension(name: string): { name: string; directory: string } {
  const directory = extensionDirectory(name);
  if (!existsSync(directory)) throw new ExtensionError("not_found", `extension '${name}' is not installed on this machine`, 3);
  const root = realpathSync(extensionsRoot());
  const target = realpathSync(directory);
  if (!inside(root, target) || dirname(target) !== root) throw new ExtensionError("internal", "refusing to remove a path outside the extensions directory");
  rmSync(directory, { recursive: true, force: false });
  return { name, directory };
}
