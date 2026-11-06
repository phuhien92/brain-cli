// What every command handler shares with the router (src/cli.ts): the error
// type, output settings, parsed flags, and the handler shape. Nothing under
// src/commands/ imports the router, so there is no import cycle; the router
// hands handlers what they need through the context.
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { Config, readScope } from "../config.js";
import type { RefreshStats, Store } from "../store.js";
import type * as telemetry from "../telemetry.js";

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exit: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface Out {
  json: boolean;
  quiet: boolean;
}

const OPTIONS = {
  vault: { type: "string" },
  json: { type: "boolean", default: false },
  quiet: { type: "boolean", short: "q", default: false },
  version: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  rebuild: { type: "boolean", default: false },
  verify: { type: "boolean", default: false },
  limit: { type: "string" },
  path: { type: "string" },
  raw: { type: "boolean", default: false },
  meta: { type: "boolean", default: false },
  section: { type: "string", multiple: true },
  lines: { type: "string" },
  body: { type: "string" },
  "source-id": { type: "string" },
  "source-created": { type: "string" },
  tag: { type: "string", multiple: true },
  kind: { type: "string" },
  force: { type: "boolean", default: false },
  "no-push": { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  as: { type: "string" },
  category: { type: "string" },
  "as-of": { type: "string" },
  on: { type: "string" },
  reason: { type: "string" },
  text: { type: "string" },
  due: { type: "boolean", default: false },
  strict: { type: "boolean", default: false },
  "include-archived": { type: "boolean", default: false },
  title: { type: "string" },
  "from-last-error": { type: "boolean", default: false },
  post: { type: "boolean", default: false },
  yes: { type: "boolean", default: false },
  machine: { type: "string" },
  agents: { type: "string" },
  telemetry: { type: "string" },
  profile: { type: "boolean", default: false },
  "user-approved": { type: "boolean", default: false },
  check: { type: "boolean", default: false },
  "update-check": { type: "string" },
} as const satisfies ParseArgsOptionsConfig;

/** brain's strict built-in parser; throws on a flag it does not know. */
export function parseFlags(argv: string[]) {
  return parseArgs({ args: argv, allowPositionals: true, strict: true, options: OPTIONS });
}

export type Flags = ReturnType<typeof parseFlags>["values"];

/** Prints a result: the --json envelope, or the human text unless --quiet. */
export type Print = (
  out: Out,
  command: string,
  data: unknown,
  vault: { vault: string; index: RefreshStats } | null,
  human: () => string,
) => void;

/** What a command that reads the vault gets: opened and closed by the router. */
export interface VaultContext {
  vault: string;
  cfg: Config;
  scope: ReturnType<typeof readScope>;
  /** Throws not_permitted when a scoped integration may not do `what`. */
  permit: (ok: boolean, what: string) => void;
  store: Store;
  /** Refresh stats from opening the vault. A handler that refreshes again
   * keeps its own copy; nothing reads this back after the handler runs. */
  index: RefreshStats;
}

export interface Ctx {
  out: Out;
  print: Print;
  /** The --json envelope's schema name (SCHEMA in the router). */
  schema: string;
  /** brain's version (VERSION in the router). */
  version: string;
  /** Path to bin/brain.js, computed once by the router. */
  bin: string;
  /** The router's vault discovery (--vault, BRAIN_VAULT, or the working folder). */
  findVault: (flag: string | undefined) => string;
  /** Telemetry for this run: a context to record, or an error code. */
  report: (r: { context?: telemetry.Context; error?: string }) => void;
  /** Present for commands that read the vault. */
  vault?: VaultContext;
}

/**
 * One command. Returns the exit code; throws to fail, and the router maps the
 * error to its code, exit code and output.
 */
export type Handler = (args: string[], flags: Flags, ctx: Ctx) => Promise<number> | number;
