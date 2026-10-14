// How an agent finds out brain exists: a skill it can load on demand, and a
// short primer injected once at session start. Both are installed per harness
// by `brain agent install <harness>`, and both read from this package, so the
// skill an agent sees is always the one that matches the installed CLI.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readScope, type Config } from "./config.js";
import { inReadScope, lifecycleStates } from "./lifecycle.js";
import { listEntries } from "./log.js";
import type { Store } from "./store.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const HARNESSES = ["claude", "pi", "agents"] as const;
export type Harness = (typeof HARNESSES)[number];

// The primer: what brain is, where the vault is, and the most recent memory
// titles. Titles only — a session should start knowing what exists, and pay
// for the detail only when it searches.
export function context(store: Store, cfg: Config, limit = 5): string {
  // Over-fetch, then drop titles already shown: two machines may hold the same
  // learning as two entries (see renderView).
  const seen = new Set<string>();
  const scope = readScope(cfg);
  const entries = listEntries(store, cfg, { limit: limit * 3 })
    .filter((e) => inReadScope(store, cfg, e.path, scope))
    .filter((e) => {
      const key = e.kind + "\n" + e.title.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
  const lines = [
    "<brain>",
    `The user's notes and long-term memory are in a markdown vault (${store.count()} notes) searchable with the \`brain\` CLI.`,
    ...(cfg.as
      ? [`You are connected as the \`${cfg.as.name}\` integration: brain shows you ${cfg.as.read === null ? "the whole vault" : cfg.as.read.join(", ")}${cfg.as.write.length ? ` and lets you record ${cfg.as.write.join(", ")} entries` : ""}.`]
      : []),
    'Before answering anything about their notes, decisions, preferences or past work, run `brain search "<question>" --json`',
    "and read the top results with `brain get <path> --json`; rephrase and search again before concluding something is not recorded.",
    'Record durable lessons with `brain log add learning "<one line>"`. See the `brain` skill for details.',
  ];
  const overdue = [...lifecycleStates(store, cfg).values()].filter((st) => st.overdue && inReadScope(store, cfg, st.path, scope));
  if (overdue.length) {
    lines.push(
      `${overdue.length} note(s) are past their review date (\`brain lifecycle status --due\`): treat facts from them as possibly stale and say so.`,
    );
  }
  if (entries.length) {
    lines.push("", "Recent memory (newest first):");
    for (const e of entries) lines.push(`- ${e.created.slice(0, 10)} [${e.kind}] ${e.title}`);
  }
  lines.push("</brain>");
  return lines.join("\n");
}

export interface InstallFile {
  path: string;
  status: "written" | "unchanged" | "conflict";
}

export interface InstallResult {
  harness: Harness;
  files: InstallFile[];
  next: string[]; // steps brain will not do for the user, such as editing their settings
  warnings: string[];
}

export function install(harness: Harness, opts: { force?: boolean; dryRun?: boolean; home?: string } = {}): InstallResult {
  const home = opts.home ?? homedir();
  const skill = readFileSync(join(PACKAGE_ROOT, "skills", "brain", "SKILL.md"), "utf8");
  const files: { path: string; content: string; owned: (s: string) => boolean }[] = [];
  const next: string[] = [];
  const warnings: string[] = [];
  const ownSkill = (s: string) => /^name:\s*brain\s*$/m.test(s);

  if (harness === "claude") {
    files.push({ path: join(home, ".claude", "skills", "brain", "SKILL.md"), content: skill, owned: ownSkill });
    next.push(
      "To give every Claude Code session your recent memory, add this to ~/.claude/settings.json",
      "(brain does not edit your settings for you):",
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "brain context" }] }] } }, null, 2),
    );
  } else {
    // Pi reads ~/.agents/skills as well as ~/.pi/agent/skills, and warns on a
    // name collision, so the skill goes to the shared location only.
    files.push({ path: join(home, ".agents", "skills", "brain", "SKILL.md"), content: skill, owned: ownSkill });
    if (harness === "pi") {
      const ext = readFileSync(join(PACKAGE_ROOT, "agents", "pi", "brain-memory.ts"), "utf8");
      files.push({
        path: join(home, ".pi", "agent", "extensions", "brain-memory.ts"),
        content: ext,
        owned: (s) => s.includes("brain context"),
      });
      if (existsSync(join(home, ".pi", "agent", "skills", "brain"))) {
        warnings.push(
          "~/.pi/agent/skills/brain also exists; Pi will see two 'brain' skills and keep the first. Remove one.",
        );
      }
      next.push("Restart Pi, or run /reload in an open session, to load the skill and the extension.");
    } else {
      next.push("Harnesses that follow the Agent Skills standard's ~/.agents/skills location will pick this up.");
    }
  }

  const result: InstallFile[] = files.map((f) => {
    const current = existsSync(f.path) ? readFileSync(f.path, "utf8") : null;
    if (current === f.content) return { path: f.path, status: "unchanged" };
    // Never replace a file brain did not write — the user may have their own
    // skill called "brain" — unless told to.
    if (current !== null && !f.owned(current) && !opts.force) return { path: f.path, status: "conflict" };
    if (!opts.dryRun) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content);
    }
    return { path: f.path, status: "written" };
  });

  return { harness, files: result, next, warnings };
}
