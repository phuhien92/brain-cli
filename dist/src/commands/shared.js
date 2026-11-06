// What every command handler shares with the router (src/cli.ts): the error
// type, output settings, parsed flags, and the handler shape. Nothing under
// src/commands/ imports the router, so there is no import cycle; the router
// hands handlers what they need through the context.
import { parseArgs } from "node:util";
export class CliError extends Error {
    code;
    exit;
    details;
    constructor(code, message, exit, details) {
        super(message);
        this.code = code;
        this.exit = exit;
        this.details = details;
    }
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
};
/** brain's strict built-in parser; throws on a flag it does not know. */
export function parseFlags(argv) {
    return parseArgs({ args: argv, allowPositionals: true, strict: true, options: OPTIONS });
}
