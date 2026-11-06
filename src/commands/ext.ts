// `brain ext` (install, list, remove) and running an installed extension as a
// command. The router dispatches extensions before its strict flag parser, so an
// extension owns its own arguments, and built-in commands always win.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig } from "../config.js";
import {
  ExtensionError,
  enabledExtensionNames,
  extensionBrainRunner,
  extensionEnvironment,
  extensionProcess,
  installExtension,
  installedManifest,
  listExtensions,
  removeExtension,
  resolveLauncher,
  type ExtensionManifest,
} from "../extensions.js";
import { CliError, type Ctx } from "./shared.js";

const EXTENSION_TIMEOUT_MS = 30_000;
const EXTENSION_OUTPUT_LIMIT = 1024 * 1024;

export async function extensionManagementCommand(args: string[], flags: Record<string, unknown>, ctx: Ctx): Promise<number> {
  const { out, print, findVault } = ctx;
  const [sub, ...rest] = args;
  const vault = findVault(flags.vault as string | undefined);

  if (sub === "install") {
    if (rest.length !== 1) throw new CliError("usage", "usage: brain ext install <path|git-url>", 2);
    // Permission approval is a human decision. JSON callers, redirected
    // processes, hooks and CI are never prompted and have no bypass flag.
    if (out.json || process.stdin.isTTY !== true || process.stderr.isTTY !== true || process.env.CI) {
      throw new CliError(
        "permission_confirmation_required",
        "extension install requires a person at an interactive terminal to review and approve its permissions",
        6,
      );
    }
    const result = await installExtension(rest[0]!, vault, confirmExtensionInstall);
    print(out, "ext.install", result, null, () =>
      result.installed
        ? `installed ${result.manifest.name} ${result.manifest.version} in ${result.directory}\nenabled for ${vault}`
        : `cancelled; ${result.manifest.name} was not installed`,
    );
    return 0;
  }

  if (sub === "list") {
    if (rest.length) throw new CliError("usage", "usage: brain ext list", 2);
    const extensions = listExtensions(vault);
    print(out, "ext.list", { extensions }, null, () =>
      extensions.length
        ? extensions.map((extension) => {
            const version = extension.manifest?.version ? ` ${extension.manifest.version}` : "";
            const status = extension.installed ? (extension.enabled ? "enabled" : "disabled") : "missing";
            return `${extension.name}${version}  ${status}${extension.error ? `  (${extension.error})` : ""}`;
          }).join("\n")
        : "no extensions installed",
    );
    return 0;
  }

  if (sub === "remove") {
    if (rest.length !== 1) throw new CliError("usage", "usage: brain ext remove <name>", 2);
    const result = removeExtension(rest[0]!);
    const stillEnabled = enabledExtensionNames(vault).includes(result.name);
    print(out, "ext.remove", { ...result, stillEnabled }, null, () =>
      `removed ${result.name} from this machine${stillEnabled ? "; it remains enabled for this vault and on other machines" : ""}`,
    );
    return 0;
  }

  throw new CliError("usage", "usage: brain ext install <path|git-url> | ext list | ext remove <name>", 2);
}

async function confirmExtensionInstall(manifest: ExtensionManifest): Promise<boolean> {
  const show = (values: string[], empty: string) => values.length ? values.join(", ") : empty;
  process.stderr.write(
    [
      "",
      `Extension: ${manifest.name} ${manifest.version}`,
      ...(manifest.description ? [`  ${manifest.description}`] : []),
      `  reads:    ${show(manifest.permissions.read, "nothing")}`,
      `  writes:   ${show(manifest.permissions.write, "nothing")}`,
      `  contacts: ${show(manifest.permissions.network, "no hosts declared")}`,
      `  receives: ${show(manifest.permissions.environment ?? [], "no ambient variables")}`,
      `  hooks:    ${show(Object.keys(manifest.hooks ?? {}), "none")}`,
      "",
      "This is code that runs with your operating-system permissions. brain enforces its",
      "read/write scope when it calls brain; declared network hosts are not sandboxed.",
    ].join("\n") + "\n",
  );
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((done) => rl.question(`Install and enable ${manifest.name} for this vault? [y/N] `, done));
    return /^\s*(y|yes)\s*$/i.test(answer);
  } finally {
    rl.close();
  }
}

interface ExtensionInvocation {
  args: string[];
  vault?: string;
  as?: string;
}

function killExtensionTree(child: ChildProcess): void {
  if (child.pid && process.platform === "win32") {
    const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    if (killed.status === 0) return;
  } else if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {}
  }
  child.kill("SIGKILL");
}

function extensionInvocation(args: string[]): ExtensionInvocation {
  const forwarded: string[] = [];
  let vault: string | undefined;
  let as: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--vault" || arg === "--as") {
      const value = args[++i];
      if (!value) throw new CliError("usage", `${arg} needs a value`, 2);
      if (arg === "--vault") vault = value;
      else as = value;
    } else if (arg.startsWith("--vault=")) vault = arg.slice("--vault=".length);
    else if (arg.startsWith("--as=")) as = arg.slice("--as=".length);
    else forwarded.push(arg);
  }
  return { args: forwarded, vault, as };
}

export async function runExtensionCommand(name: string, rawArgs: string[], ctx: Ctx): Promise<number> {
  const { out, findVault, schema: SCHEMA } = ctx;
  const invocation = extensionInvocation(rawArgs);
  const vault = findVault(invocation.vault);
  const parentAs = invocation.as ?? process.env.BRAIN_AS ?? "";
  const cfg = loadConfig(vault, { as: parentAs || undefined });
  const installed = installedManifest(name);
  if (!enabledExtensionNames(vault).includes(name)) {
    if (!installed) throw new CliError("usage", `unknown command '${name}' — run 'brain help'`, 2);
    throw new CliError("not_found", `extension '${name}' is not enabled for this vault`, 3);
  }
  if (!installed) throw new CliError("not_found", `extension '${name}' is not installed on this machine`, 3);
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
  const env: NodeJS.ProcessEnv = {
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
  if (parentAs) env.BRAIN_EXTENSION_PARENT_AS = parentAs;
  else delete env.BRAIN_EXTENSION_PARENT_AS;
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    error?: Error;
    policyError?: ExtensionError;
  }>((done) => {
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
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let spawnError: Error | undefined;
    let policyError: ExtensionError | undefined;
    const stop = (error: ExtensionError) => {
      if (policyError) return;
      policyError = error;
      child.stdout.destroy();
      child.stderr.destroy();
      killExtensionTree(child);
    };
    const capture = (chunks: Buffer[]) => (chunk: Buffer) => {
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
    const timeout = setTimeout(
      () => stop(new ExtensionError("extension_timeout", `${name} exceeded the 30 second time limit`)),
      EXTENSION_TIMEOUT_MS,
    );
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
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.policyError) throw result.policyError;
  if (result.error) throw new ExtensionError("extension_failed", `${name} could not start: ${result.error.message}`);
  if (result.signal) throw new ExtensionError("extension_failed", `${name} was terminated by ${result.signal}`);

  const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  let envelope: Record<string, unknown> | null = null;
  if (lines.length === 1) {
    try {
      const parsed = JSON.parse(lines[0]!) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) envelope = parsed as Record<string, unknown>;
    } catch {
      // Report a protocol error below without echoing arbitrary extension output.
    }
  }
  const envelopeError = envelope?.error;
  const validError = !!envelopeError
    && typeof envelopeError === "object"
    && !Array.isArray(envelopeError)
    && typeof (envelopeError as Record<string, unknown>).code === "string"
    && (envelopeError as Record<string, unknown>).code !== ""
    && typeof (envelopeError as Record<string, unknown>).message === "string";
  const valid = envelope?.schema === SCHEMA
    && typeof envelope.command === "string"
    && typeof envelope.ok === "boolean"
    && (envelope.ok === true
      ? Object.hasOwn(envelope, "data") && !Object.hasOwn(envelope, "error")
      : !Object.hasOwn(envelope, "data") && Object.hasOwn(envelope, "error") && validError);
  if (!valid) {
    throw new ExtensionError(
      "extension_protocol",
      `${name} must print exactly one ${SCHEMA} JSON envelope; received ${lines.length} non-empty stdout line(s)`,
    );
  }
  if ((envelope!.ok === true && result.code !== 0) || (envelope!.ok === false && result.code === 0)) {
    throw new ExtensionError("extension_protocol", `${name} returned an exit code that disagrees with its envelope`);
  }
  if (envelope!.ok === false) {
    ctx.report({ error: "extension_failed" });
  }
  if (envelope!.ok === false || out.json || !out.quiet) process.stdout.write(lines[0]!.trim() + "\n");
  return result.code ?? 1;
}
