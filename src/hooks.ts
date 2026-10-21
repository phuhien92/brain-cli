// Manifest hooks are isolated child processes. context.build is awaited under one
// small shared budget; log.added is handed to a detached supervisor only after
// the entry is durable and indexed.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inScope, readScope, type Config } from "./config.js";
import {
  enabledExtensionNames,
  extensionBrainProcess,
  extensionProcess,
  installedManifest,
  resolveHookLauncher,
  type ExtensionManifest,
  type HookEvent,
} from "./extensions.js";
import { entryAt } from "./log.js";
import { vaultStateDir } from "./paths.js";
import type { Store } from "./store.js";

const HOOK_SCHEMA = "brain.hook.v1";
const CONTEXT_BUDGET_MS = 300;
const LOG_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 64 * 1024;
const RUNTIME_ENV = new Set([
  "COMSPEC", "DO_NOT_TRACK", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR", "PATH",
  "PATHEXT", "SYSTEMROOT", "TEMP", "TERM", "TMP", "TMPDIR", "TZ", "USERPROFILE", "WINDIR",
]);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "brain.js");

interface HookJob {
  vault: string;
  machine: string;
  parentAs: string;
  name: string;
  event: HookEvent;
  data: Record<string, unknown>;
}

interface HookResult {
  lines: string[];
}

function diagnostic(vault: string, event: HookEvent, name: string, error: unknown): void {
  try {
    const directory = vaultStateDir(vault);
    mkdirSync(directory, { recursive: true });
    const message = error instanceof Error ? error.message : String(error);
    appendFileSync(join(directory, "hooks.log"), `${new Date().toISOString()} ${event} ${name}: ${message.replace(/[\r\n]+/g, " ")}\n`);
  } catch {
    // Hook diagnostics must never affect the command which emitted the event.
  }
}

function hookEnvironment(manifest: ExtensionManifest): NodeJS.ProcessEnv {
  const allowed = new Set([...RUNTIME_ENV, ...(manifest.permissions.environment ?? [])]);
  const normalized = process.platform === "win32" ? new Set([...allowed].map((key) => key.toUpperCase())) : allowed;
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && normalized.has(process.platform === "win32" ? key.toUpperCase() : key),
  ));
}

function scopedRunner(job: HookJob, directory: string): { directory: string; file: string; args: string[]; token: string } {
  const runnerDirectory = mkdtempSync(join(tmpdir(), "brain-hook-"));
  const runner = join(runnerDirectory, "brain.mjs");
  const launch = extensionBrainProcess(runner);
  const token = randomUUID();
  const locked: Record<string, string | null> = {
    BRAIN_VAULT: job.vault,
    BRAIN_CONFIG: process.env.BRAIN_CONFIG ?? null,
    BRAIN_STATE_DIR: process.env.BRAIN_STATE_DIR ?? null,
    BRAIN_EXTENSIONS_DIR: dirname(directory),
    BRAIN_AS: job.parentAs || job.name,
    BRAIN_MACHINE: job.machine,
    BRAIN_EXTENSION_SCOPE: job.name,
    BRAIN_EXTENSION_PARENT_AS: job.parentAs || null,
    BRAIN_HOOK_EVENT: job.event,
    BRAIN_EXT_REDACT: "1",
    BRAIN_EXT_REDACT_TOKEN: token,
    BRAIN_BIN: launch.file,
    BRAIN_BIN_ARGS_JSON: JSON.stringify(launch.args),
  };
  writeFileSync(runner, `const locked = ${JSON.stringify(locked)};
for (const [key, value] of Object.entries(locked)) {
  if (value === null) delete process.env[key];
  else process.env[key] = value;
}
await import(${JSON.stringify(pathToFileURL(BIN).href)});
`);
  return { directory: runnerDirectory, file: launch.file, args: launch.args, token };
}

function killTree(child: ChildProcess, detached: boolean): void {
  if (child.pid && process.platform === "win32") {
    if (spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).status === 0) return;
  } else if (child.pid && detached) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {}
  }
  child.kill("SIGKILL");
}

async function runHook(job: HookJob, timeoutMs: number): Promise<HookResult> {
  const installed = installedManifest(job.name);
  if (!installed) throw new Error("is enabled but not installed");
  const launcher = resolveHookLauncher(installed.directory, installed.manifest, job.event);
  const runner = scopedRunner(job, installed.directory);
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string; problem?: string }>((done) => {
      const launch = extensionProcess(launcher, []);
      const detached = process.platform !== "win32";
      const env: NodeJS.ProcessEnv = {
        ...hookEnvironment(installed.manifest),
        ...launch.env,
        BRAIN_VAULT: job.vault,
        BRAIN_BIN: runner.file,
        BRAIN_BIN_ARGS_JSON: JSON.stringify(runner.args),
        BRAIN_AS: job.parentAs || job.name,
        BRAIN_EXT_DIR: installed.directory,
        BRAIN_MACHINE: job.machine,
        BRAIN_EXTENSION_SCOPE: job.name,
        BRAIN_EXT_REDACT: "1",
        BRAIN_EXT_REDACT_TOKEN: runner.token,
      };
      if (job.parentAs) env.BRAIN_EXTENSION_PARENT_AS = job.parentAs;
      const child = spawn(launch.file, launch.args, {
        cwd: installed.directory,
        detached,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let problem: string | undefined;
      const stop = (why: string) => {
        if (problem) return;
        problem = why;
        child.stdout.destroy();
        child.stderr.destroy();
        killTree(child, detached);
      };
      const capture = (chunks: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > OUTPUT_LIMIT) stop(`exceeded the ${OUTPUT_LIMIT} byte output limit`);
        else chunks.push(chunk);
      };
      child.stdout.on("data", capture(stdout));
      child.stderr.on("data", capture(stderr));
      child.on("error", (error) => { problem = `could not start: ${error.message}`; });
      child.stdin.end(JSON.stringify({ schema: HOOK_SCHEMA, event: job.event, data: job.data }) + "\n");
      const timer = setTimeout(() => stop(`exceeded the ${timeoutMs} ms time limit`), Math.max(1, timeoutMs));
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), problem });
      });
    });
    if (result.problem) throw new Error(result.problem);
    if (result.code !== 0) throw new Error(`exited ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 1000)}` : ""}`);
    const output = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (output.length !== 1) throw new Error(`must print exactly one ${HOOK_SCHEMA} JSON line`);
    let envelope: unknown;
    try { envelope = JSON.parse(output[0]!); } catch { throw new Error(`returned invalid ${HOOK_SCHEMA} JSON`); }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error(`returned invalid ${HOOK_SCHEMA} envelope`);
    const record = envelope as Record<string, unknown>;
    if (record.schema !== HOOK_SCHEMA || record.event !== job.event || record.ok !== true || !record.data || typeof record.data !== "object" || Array.isArray(record.data)) {
      throw new Error(`returned invalid ${HOOK_SCHEMA} envelope`);
    }
    if (job.event !== "context.build") return { lines: [] };
    const lines = (record.data as Record<string, unknown>).lines;
    if (!Array.isArray(lines) || lines.length > 20 || lines.some((line) => typeof line !== "string" || !line || line.length > 1000 || /[\r\n]/.test(line))) {
      throw new Error("context.build data.lines must be at most 20 non-empty single-line strings");
    }
    return { lines: lines as string[] };
  } finally {
    rmSync(runner.directory, { recursive: true, force: true });
  }
}

function jobs(vault: string, cfg: Config, event: HookEvent, data: Record<string, unknown>, path?: string): HookJob[] {
  if (process.env.BRAIN_HOOK_EVENT) return [];
  const parentAs = process.env.BRAIN_EXTENSION_SCOPE ? process.env.BRAIN_EXTENSION_PARENT_AS ?? "" : cfg.as?.name ?? "";
  return enabledExtensionNames(vault).flatMap((name) => {
    try {
      const installed = installedManifest(name);
      if (!installed?.manifest.hooks?.[event]) return [];
      const manifestScope = installed.manifest.permissions.read.includes("*")
        ? null
        : [...installed.manifest.permissions.read, ...installed.manifest.permissions.write.map((kind) => `${cfg.logDir}/${kind}/`)];
      if (path && (!inScope(path, readScope(cfg)) || !inScope(path, manifestScope))) return [];
      return [{ vault, machine: cfg.machine, parentAs, name, event, data }];
    } catch (error) {
      diagnostic(vault, event, name, error);
      return [];
    }
  });
}

export async function contextHookLines(vault: string, cfg: Config, budgetMs = CONTEXT_BUDGET_MS): Promise<string[]> {
  let hookJobs: HookJob[];
  try {
    hookJobs = jobs(vault, cfg, "context.build", {});
  } catch (error) {
    diagnostic(vault, "context.build", "discovery", error);
    return [];
  }
  const started = Date.now();
  const results = await Promise.all(hookJobs.map(async (job) => {
    try {
      return await runHook(job, Math.max(1, budgetMs - (Date.now() - started)));
    } catch (error) {
      diagnostic(vault, job.event, job.name, error);
      return { lines: [] };
    }
  }));
  return results.flatMap((result) => result.lines);
}

export function dispatchLogAddedHooks(store: Store, cfg: Config, paths: string[]): void {
  const hookJobs = paths.flatMap((path) => {
    try {
      const found = entryAt(store, path);
      if (!found) return [];
      const { created: _created, ...entry } = found;
      return jobs(store.vault, cfg, "log.added", { entry }, path);
    } catch (error) {
      diagnostic(store.vault, "log.added", "discovery", error);
      return [];
    }
  });
  if (!hookJobs.length) return;
  const jobFile = join(tmpdir(), `brain-hook-${process.pid}-${randomUUID()}.json`);
  try {
    writeFileSync(jobFile, JSON.stringify(hookJobs), { flag: "wx", mode: 0o600 });
    const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), "worker", jobFile], {
      detached: process.platform !== "win32",
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    });
    worker.unref();
  } catch (error) {
    rmSync(jobFile, { force: true });
    diagnostic(store.vault, "log.added", "supervisor", error);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "worker") {
  let hookJobs: HookJob[] = [];
  try {
    const jobFile = process.argv[3]!;
    hookJobs = JSON.parse(readFileSync(jobFile, "utf8")) as HookJob[];
    rmSync(jobFile, { force: true });
  } catch {}
  for (const job of hookJobs) {
    try {
      await runHook(job, LOG_TIMEOUT_MS);
    } catch (error) {
      diagnostic(job.vault, job.event, job.name, error);
    }
  }
}
