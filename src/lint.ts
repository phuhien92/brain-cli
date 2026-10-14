// Vault health: what a person (or an agent) would want to fix.
//
// Every rule reads the index and the file tree; none changes anything. A
// finding names the file, the rule and what to do. Severities: "warn" for
// things that make answers wrong or links dead, "info" for housekeeping.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { inReadScope, inScope, readScope, type Config } from "./config.js";
import { lifecycleStates } from "./lifecycle.js";
import { LIFECYCLE_KIND } from "./log.js";
import { basename, parseNote, type FrontmatterValue } from "./note.js";
import { SOURCE_SIDECAR_SUFFIX, sourceSidecars } from "./source.js";
import type { Store } from "./store.js";

export interface Finding {
  rule: "broken-link" | "orphan" | "conflict-copy" | "review-overdue" | "lifecycle" | "max-lines" | "source-missing" | "source-modified" | "unsourced";
  severity: "warn" | "info";
  path: string;
  message: string;
}

// Names sync services give the loser of a conflict. Each must match a file
// whose "original" also exists, so a note honestly titled "Plan 2" is fine.
const CONFLICT_PATTERNS: { re: RegExp; service: string }[] = [
  { re: /^(.*) \d+(\.md)$/i, service: "iCloud" }, // "Note 2.md"
  { re: /^(.*) \([^)]*conflicted copy[^)]*\)(\.md)$/i, service: "Dropbox/Obsidian Sync" },
  { re: /^(.*)\.sync-conflict-[^.]+(\.md)$/i, service: "Syncthing" },
];

export function lint(store: Store, cfg: Config): Finding[] {
  const findings: Finding[] = [];
  const scope = readScope(cfg);
  const logPrefix = `${cfg.logDir}/`;

  const notes = (store.db.prepare("SELECT path, title, aliases, frontmatter FROM notes").all() as {
    path: string;
    title: string;
    aliases: string;
    frontmatter: string;
  }[]).filter((n) => inReadScope(store, cfg, n.path, scope));
  const allPaths = new Set(notes.map((n) => n.path));
  const lower = (s: string) => s.toLowerCase();

  // Resolution tables, the way Obsidian resolves [[links]].
  const byPath = new Map(notes.map((n) => [lower(n.path), n.path] as const));
  const byName = new Map<string, string>();
  const byTitle = new Map<string, string>();
  for (const n of notes) {
    byName.set(lower(basename(n.path)), n.path);
    byTitle.set(lower(n.title), n.path);
    for (const a of JSON.parse(n.aliases) as string[]) byTitle.set(lower(a), n.path);
  }
  // Every non-note file (attachments, .excalidraw boards, sources), findable
  // by vault path, file name, or file name without its extension.
  const sidecars = sourceSidecars(store.vault);
  const originals = new Set(sidecars.map((sidecar) => sidecar.slice(0, -SOURCE_SIDECAR_SUFFIX.length)));
  const managed = new Set([...sidecars, ...originals]);
  const files = new Map<string, string>();
  for (const f of walkFiles(store.vault, originals)) {
    const name = lower(f.split("/").pop()!);
    for (const key of [lower(f), name, name.replace(/\.[^.]+$/, "")]) if (!files.has(key)) files.set(key, f);
  }

  const resolve = (target: string): string | null => {
    const t = lower(target.replace(/\\/g, "/").replace(/^\.?\//, ""));
    const withExt = t.endsWith(".md") ? t : `${t}.md`;
    const exact = byPath.get(t) ?? byPath.get(withExt);
    if (exact) return exact;
    const suffix = notes.find((n) => lower(n.path).endsWith(`/${withExt}`));
    if (suffix) return suffix.path;
    const name = basename(t);
    const note = byName.get(name) ?? byTitle.get(name) ?? byTitle.get(t);
    if (note) return note;
    return files.get(t) ?? files.get(t.split("/").pop()!) ?? null;
  };

  // broken-link, and inbound counts for orphans
  const inbound = new Map<string, number>();
  const links = store.db.prepare("SELECT src, target FROM links").all() as { src: string; target: string }[];
  const explicitSources = new Map(notes.map((n) => [n.path, sourceTargets(JSON.parse(n.frontmatter) as Record<string, FrontmatterValue>)]));
  const linksBySource = new Map<string, string[]>();
  for (const link of links) linksBySource.set(link.src, [...(linksBySource.get(link.src) ?? []), link.target]);
  const reported = new Set<string>();
  for (const l of links) {
    if (!allPaths.has(l.src)) continue;
    const hit = resolve(l.target);
    if (hit) {
      inbound.set(hit, (inbound.get(hit) ?? 0) + 1);
      continue;
    }
    if (explicitSources.get(l.src)?.includes(l.target)) continue; // reported by source-missing below
    const isAttachment = /\.[a-z0-9]+$/i.test(l.target) && !/\.md$/i.test(l.target);
    const key = `${l.src}\n${l.target}`;
    if (reported.has(key)) continue;
    reported.add(key);
    findings.push({
      rule: "broken-link",
      severity: "warn",
      path: l.src,
      message: `[[${l.target}]] does not resolve to any note${isAttachment ? " or file" : ""}`,
    });
  }

  // orphan: nothing links here. Root-level notes and log entries are entry
  // points by design, not orphans.
  for (const n of notes) {
    if (!n.path.includes("/") || n.path.startsWith(logPrefix) || managed.has(n.path)) continue;
    if (!inbound.get(n.path)) {
      findings.push({ rule: "orphan", severity: "info", path: n.path, message: "no note links here" });
    }
  }

  // conflict-copy: a sync service kept both sides of a conflict
  for (const n of notes) {
    const file = n.path.split("/").pop()!;
    const dir = n.path.slice(0, n.path.length - file.length);
    for (const { re, service } of CONFLICT_PATTERNS) {
      const m = re.exec(file);
      if (m && allPaths.has(`${dir}${m[1]}${m[2]}`)) {
        findings.push({
          rule: "conflict-copy",
          severity: "warn",
          path: n.path,
          message: `looks like a ${service} conflict copy of ${dir}${m[1]}${m[2]}; merge the two and delete one`,
        });
        break;
      }
    }
  }

  // lifecycle: overdue reviews, bad metadata, events for notes that are gone
  for (const st of lifecycleStates(store, cfg).values()) {
    if (!inReadScope(store, cfg, st.path, scope)) continue;
    if (!allPaths.has(st.path)) {
      findings.push({
        rule: "lifecycle",
        severity: "warn",
        path: st.path,
        message: `lifecycle entries in ${cfg.logDir}/${LIFECYCLE_KIND}/ point at a note that no longer exists (renamed or deleted?)`,
      });
      continue;
    }
    if (st.overdue) {
      findings.push({
        rule: "review-overdue",
        severity: "warn",
        path: st.path,
        message: `${st.category} note was due for review on ${st.due}; confirm it (brain lifecycle review) or archive it`,
      });
    }
    for (const p of st.problems) findings.push({ rule: "lifecycle", severity: "warn", path: st.path, message: p });
  }

  // source-missing: explicit provenance must resolve to a note or file.
  for (const n of notes) {
    for (const target of explicitSources.get(n.path) ?? []) {
      if (!resolve(target)) {
        findings.push({
          rule: "source-missing",
          severity: "warn",
          path: n.path,
          message: `source [[${target}]] does not resolve to any note or file`,
        });
      }
    }
  }

  // source-modified: every sidecar still has its original, and the
  // original's bytes still match the digest the sidecar recorded.
  for (const sidecar of sidecars) {
    if (!inScope(sidecar, scope)) continue;
    const path = sidecar.slice(0, -SOURCE_SIDECAR_SUFFIX.length);
    if (!existsSync(join(store.vault, ...path.split("/")))) {
      findings.push({ rule: "source-modified", severity: "warn", path: sidecar, message: `source file ${path} is missing` });
      continue;
    }
    let expected: unknown;
    try {
      expected = parseNote(sidecar, readFileSync(join(store.vault, ...sidecar.split("/")), "utf8")).frontmatter.sha256;
    } catch {
      expected = null;
    }
    const actual = createHash("sha256").update(readFileSync(join(store.vault, ...path.split("/")))).digest("hex");
    if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
      findings.push({ rule: "source-modified", severity: "warn", path, message: `${sidecar} has no valid sha256` });
    } else if (actual !== expected) {
      findings.push({ rule: "source-modified", severity: "warn", path, message: `sha256 does not match ${sidecar}` });
    }
  }

  // unsourced: selected folders require either an explicit `sources:` entry
  // or a normal wiki-link that resolves to an ingested source.
  for (const n of notes) {
    if (managed.has(n.path) || !cfg.lintUnsourced.some((prefix) => n.path.startsWith(prefix))) continue;
    const explicit = explicitSources.get(n.path) ?? [];
    const linked = (linksBySource.get(n.path) ?? []).some((target) => managed.has(resolve(target) ?? ""));
    if (!explicit.length && !linked) {
      findings.push({ rule: "unsourced", severity: "info", path: n.path, message: "no source citation" });
    }
  }

  // max-lines: per-file limits the vault sets for itself
  for (const [path, max] of Object.entries(cfg.lintMaxLines)) {
    if (!allPaths.has(path)) continue;
    const content = store.get(path)?.content ?? "";
    const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0); // as `wc -l` counts
    if (lines > max) {
      findings.push({ rule: "max-lines", severity: "warn", path, message: `${lines} lines, over this vault's limit of ${max}` });
    }
  }

  const order = { warn: 0, info: 1 } as const;
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.rule.localeCompare(b.rule) || a.path.localeCompare(b.path));
}

function sourceTargets(frontmatter: Record<string, FrontmatterValue>): string[] {
  const value = frontmatter.sources;
  if (value === undefined || value === null) return [];
  const targets: string[] = [];
  for (const item of Array.isArray(value) ? value : [String(value)]) {
    for (const match of item.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
      const target = match[1]!.split(/\\?\|/)[0]!.split("#")[0]!.trim();
      if (target && !targets.includes(target)) targets.push(target);
    }
  }
  return targets;
}

function* walkFiles(root: string, originals: Set<string>, dir = root): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(root, originals, full);
    else if (e.isFile()) {
      const rel = relative(root, full).split(sep).join("/");
      if (!e.name.toLowerCase().endsWith(".md") || originals.has(rel)) {
        yield rel;
      }
    }
  }
}
