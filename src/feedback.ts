// Feedback from the people and agents using brain: drafted locally, redacted,
// and posted to GitHub only when a person asked for it or allowed it.
//
// Drafts live in the state directory, not in the vault. A draft holds the
// reporter's words and diagnostics brain gathers itself (versions, the
// command, the error code). Before anything is shown or posted, it is
// redacted: the vault path, the home directory, every indexed note's path and
// title, email addresses, long numbers and money amounts become placeholders.

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { stateRoot } from "./paths.js";

export const KINDS = ["bug", "idea", "docs"] as const;
export type Kind = (typeof KINDS)[number];
export const DEFAULT_REPO = "phuhien92/brain-cli";

export interface LastError {
  time: string;
  command: string;
  args: string[];
  code: string;
  exit: number;
  message: string;
  version: string;
}

export interface Draft {
  id: string;
  created: string;
  kind: Kind;
  title: string;
  body: string; // already redacted
  diagnostics: Record<string, string>;
  fingerprint: string; // same kind of problem → same fingerprint, to spot duplicates
  status: "draft" | "submitted";
  url: string | null;
}

const dir = () => join(stateRoot(), "feedback");

export function saveLastError(e: LastError): void {
  try {
    mkdirSync(stateRoot(), { recursive: true });
    writeFileSync(join(stateRoot(), "last-error.json"), JSON.stringify(e, null, 2) + "\n");
  } catch {
    // never let error bookkeeping cause an error
  }
}

export function lastError(): LastError | null {
  try {
    return JSON.parse(readFileSync(join(stateRoot(), "last-error.json"), "utf8")) as LastError;
  } catch {
    return null;
  }
}

export interface Redactor {
  (text: string): string;
}

// Build a redactor for this machine and vault. Longest strings first, so a
// note path is replaced before the vault path inside it.
export function redactor(opts: { vault?: string | null; notes?: { path: string; title: string }[] }): Redactor {
  const swaps: [string, string][] = [];
  (opts.notes ?? []).forEach((n, i) => {
    swaps.push([n.path, `<note-${i + 1}>`]);
    swaps.push([n.path.replace(/\.md$/i, ""), `<note-${i + 1}>`]);
    if (n.title.trim().length >= 4) swaps.push([n.title.trim(), `<note-${i + 1}-title>`]);
  });
  if (opts.vault) swaps.push([opts.vault, "<vault>"]);
  swaps.push([homedir(), "~"]);
  swaps.sort((a, b) => b[0].length - a[0].length);
  return (text: string) => {
    let out = text;
    for (const [from, to] of swaps) if (from) out = out.split(from).join(to);
    return out
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
      .replace(/[$€£]\s?\d[\d,]*(\.\d+)?/g, "<amount>")
      .replace(/\b\d{6,}\b/g, "<number>")
      .replace(/#\s?[A-Z0-9]{6,}\b/g, "#<id>")
      .replace(/\/(Users|home)\/[^/\s"']+/g, "~");
  };
}

export function diagnostics(version: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    brain: version,
    node: process.versions.node,
    os: `${platform()}-${arch()}`,
    ...extra,
  };
}

export function createDraft(input: { kind: Kind; title: string; body: string; diagnostics: Record<string, string>; fingerprintSeed: string }, redact: Redactor): Draft {
  const id = `${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString("hex")}`;
  const draft: Draft = {
    id,
    created: new Date().toISOString(),
    kind: input.kind,
    title: redact(input.title).slice(0, 120),
    body: redact(input.body),
    diagnostics: Object.fromEntries(Object.entries(input.diagnostics).map(([k, v]) => [k, redact(v)])),
    fingerprint: createHash("sha256").update(input.fingerprintSeed).digest("hex").slice(0, 10),
    status: "draft",
    url: null,
  };
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), `${id}.json`), JSON.stringify(draft, null, 2) + "\n", { flag: "wx" });
  return draft;
}

export function listDrafts(): Draft[] {
  if (!existsSync(dir())) return [];
  return readdirSync(dir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir(), f), "utf8")) as Draft)
    .sort((a, b) => b.created.localeCompare(a.created));
}

export function getDraft(id: string): Draft | null {
  const f = join(dir(), `${id.replace(/[^A-Za-z0-9-]/g, "")}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Draft) : null;
}

export function markSubmitted(d: Draft, url: string): Draft {
  const next = { ...d, status: "submitted" as const, url };
  writeFileSync(join(dir(), `${d.id}.json`), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function issueBody(d: Draft): string {
  const diag = Object.entries(d.diagnostics).map(([k, v]) => `| ${k} | \`${v.replace(/\|/g, "\\|")}\` |`).join("\n");
  return [
    d.body,
    "",
    "### Diagnostics",
    "",
    "| | |",
    "| --- | --- |",
    diag,
    `| fingerprint | \`${d.fingerprint}\` |`,
    "",
    `<!-- filed with brain feedback (${d.kind}); redacted on the reporter's machine -->`,
  ].join("\n");
}

export function repo(): string {
  return process.env.BRAIN_FEEDBACK_REPO || DEFAULT_REPO;
}

// A pre-filled "new issue" page: a person reads it and clicks Submit. No token.
export function issueUrl(d: Draft): string {
  const params = new URLSearchParams({
    title: `[${d.kind}] ${d.title}`,
    body: issueBody(d).slice(0, 6000),
    labels: `agent-report,${d.kind}`,
  });
  return `https://github.com/${repo()}/issues/new?${params.toString()}`;
}

// Post directly with the GitHub CLI. Only called after the permission check.
export function postWithGh(d: Draft): string {
  return execFileSync(
    "gh",
    ["issue", "create", "--repo", repo(), "--title", `[${d.kind}] ${d.title}`, "--body", issueBody(d)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}
