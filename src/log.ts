// The append-only log: one markdown file per entry.
//
// This is what makes the vault safe to sync between machines with plain git.
// Two machines appending to one learnings.md produce a merge conflict on the
// first sync; ordinary entries use machine-specific names and never do.
// Source imports deliberately use one deterministic path across machines so
// identical imports merge and divergent content conflicts. Every write in this
// module is still create-only — none edits an existing file.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inReadScope, slug, type Config, type ExportTarget } from "./config.js";
import { parseNote } from "./note.js";
import type { Store } from "./store.js";

export interface Entry {
  path: string;
  kind: string;
  title: string;
  created: string;
  machine: string;
  tags: string[];
  body: string;
}

export interface NewEntry {
  kind: string;
  title: string;
  body?: string;
  tags?: string[];
  created?: Date;
  fields?: Record<string, string>; // extra frontmatter, e.g. a lifecycle event's target
}

export const RETIRE_ACTION = "retire";
export const LIFECYCLE_KIND = "lifecycle";

export interface RetirementCandidate {
  path: string;
  title: string;
  body: string;
  reason?: "ambiguous-title";
}

// A previously exported entry whose title is still in the file with a new body.
export interface ReplacementCandidate extends RetirementCandidate {
  replacement: { title: string; body: string };
}

export function addEntry(vault: string, cfg: Config, input: NewEntry): string {
  const { dir, name, content } = prepareEntry(vault, cfg, input);

  // 'wx' fails if the file exists, so a same-second, same-title entry gets a
  // suffix instead of silently replacing the first.
  for (let n = 1; ; n++) {
    const file = join(dir, n === 1 ? `${name}.md` : `${name}-${n}.md`);
    try {
      writeFileSync(file, content, { flag: "wx" });
      return `${cfg.logDir}/${slug(input.kind)}/${file.slice(dir.length + 1)}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

export function addEntryOnce(
  store: Store,
  cfg: Config,
  input: NewEntry,
  sourceId: string,
  created: Date,
  machine: string,
): { path: string; added: boolean; machine: string } {
  if (!/^[0-9a-f]{64}$/.test(sourceId)) throw new Error("source ID must be a SHA-256 hash");
  const kind = slug(input.kind);
  const prefix = `${cfg.logDir}/${kind}/`.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
  const indexed = store.db.prepare(
    `SELECT path, json_extract(frontmatter, '$.machine') AS machine FROM notes
      WHERE path LIKE ? ESCAPE '\\'
        AND json_extract(frontmatter, '$.kind') = ?
        AND json_extract(frontmatter, '$.source-id') = ?
      ORDER BY path LIMIT 1`,
  ).get(prefix, kind, sourceId) as { path: string; machine: string } | undefined;
  if (indexed) return { path: indexed.path, added: false, machine: indexed.machine };
  const withSource = { ...input, fields: { ...input.fields, "source-id": sourceId } };
  const { dir, content } = prepareEntry(store.vault, cfg, withSource, { created, machine });
  const relativePath = `${cfg.logDir}/${kind}/source-${sourceId}.md`;
  const file = join(dir, `source-${sourceId}.md`);
  try {
    writeFileSync(file, content, { flag: "wx" });
    return { path: relativePath, added: true, machine };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const existing = parseNote(relativePath, readFileSync(file, "utf8"));
    if (existing.frontmatter.kind !== kind || existing.frontmatter["source-id"] !== sourceId) {
      throw new Error(`source ID path '${relativePath}' is occupied by a different entry`);
    }
    return { path: relativePath, added: false, machine: String(existing.frontmatter.machine ?? "") };
  }
}

function prepareEntry(
  vault: string,
  cfg: Config,
  input: NewEntry,
  origin?: { created: Date; machine: string },
): { dir: string; name: string; content: string } {
  const kind = slug(input.kind);
  if (!kind) throw new Error("an entry needs a kind, e.g. 'learning'");
  const title = input.title.replace(/\s+/g, " ").trim();
  if (!title) throw new Error("an entry needs a title");

  const created = origin?.created ?? input.created ?? new Date();
  const iso = created.toISOString(); // millisecond precision: the view's order is creation order
  const day = iso.slice(0, 10);
  const machine = origin?.machine ?? cfg.machine;
  const name = `${day}-${machine}-${slug(title) || "entry"}`;
  const dir = join(vault, ...cfg.logDir.split("/"), kind);
  mkdirSync(dir, { recursive: true });

  const tags = [...new Set((input.tags ?? []).map((t) => t.replace(/^#/, "").trim().toLowerCase()).filter(Boolean))];
  const lines = ["---", `kind: ${kind}`, `created: ${iso}`, `machine: ${JSON.stringify(machine)}`];
  if (tags.length) lines.push(`tags: [${tags.join(", ")}]`);
  for (const [key, value] of Object.entries(input.fields ?? {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error(`invalid entry field ${key}`);
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---", `# ${title}`, "");
  const body = (input.body ?? "").replace(/\r\n/g, "\n").trim();
  const content = lines.join("\n") + (body ? `\n${body}\n` : "");
  return { dir, name, content };
}

export function listEntries(
  store: Store,
  cfg: Config,
  opts: { kind?: string; limit?: number; includeRetired?: boolean } = {},
): Entry[] {
  const rows = store.db
    .prepare(
      `SELECT path, title, frontmatter, tags FROM notes
        WHERE path LIKE ? ESCAPE '\\'
          AND json_extract(frontmatter, '$.kind') IS NOT NULL
          AND (? IS NULL OR json_extract(frontmatter, '$.kind') = ?)
          AND (? = 1 OR path NOT IN (
            SELECT json_extract(events.frontmatter, '$.target')
              FROM notes AS events
             WHERE events.path LIKE ? ESCAPE '\\'
               AND json_extract(events.frontmatter, '$.action') = '${RETIRE_ACTION}'
               AND json_extract(events.frontmatter, '$.target') IS NOT NULL
          ))
        ORDER BY json_extract(frontmatter, '$.created') DESC, path DESC
        LIMIT ?`,
    )
    .all(
      cfg.logDir.replace(/[\\%_]/g, (c) => `\\${c}`) + "/%",
      opts.kind ?? null,
      opts.kind ?? null,
      opts.includeRetired ? 1 : 0,
      `${cfg.logDir}/${LIFECYCLE_KIND}`.replace(/[\\%_]/g, (c) => `\\${c}`) + "/%",
      opts.limit ?? -1,
    ) as { path: string; title: string; frontmatter: string; tags: string }[];

  return rows.map((r) => {
    const fm = JSON.parse(r.frontmatter) as Record<string, unknown>;
    const raw = readFileSync(join(store.vault, ...r.path.split("/")), "utf8");
    return {
      path: r.path,
      kind: String(fm.kind),
      title: r.title,
      created: String(fm.created ?? ""),
      machine: String(fm.machine ?? ""),
      tags: JSON.parse(r.tags) as string[],
      body: entryBody(raw),
    };
  });
}

// Record a retirement as a separate lifecycle entry. Multiple machines may
// retire the same target; each event is valid and no existing file is touched.
export function recordRetirement(
  vault: string,
  cfg: Config,
  target: string,
  opts: { reason?: string; replacement?: string } = {},
): string {
  const fields: Record<string, string> = { target, action: RETIRE_ACTION };
  if (opts.reason) fields.reason = opts.reason;
  if (opts.replacement) fields.replacement = opts.replacement;
  return addEntry(vault, cfg, {
    kind: LIFECYCLE_KIND,
    title: `${target}: retired`,
    body: opts.reason,
    fields,
  });
}

// The body after the frontmatter and the leading "# title" line.
function entryBody(raw: string): string {
  return raw
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, "")
    .replace(/^\s*#[ \t]+[^\n]*\n?/, "")
    .trim();
}

// A view is every entry of one kind, oldest first, as a markdown list: the
// shape tools that predate brain (firstmate's learnings.md) already read.
export function renderView(entries: Entry[], header?: string): string {
  const rendered = [...entries].sort((a, b) => a.created.localeCompare(b.created) || a.path.localeCompare(b.path));
  const out: string[] = [];
  if (header) out.push(header);
  const kind = entries[0]?.kind ?? "entry";
  out.push(`<!-- generated by brain from ${rendered.length} ${kind} entries; add one with: brain log add ${kind} "<text>" -->`);
  for (const e of rendered) {
    out.push(`- ${e.title}`);
    if (e.body) for (const line of e.body.split("\n")) out.push(line.trim() ? `  ${line}` : "");
  }
  return out.join("\n") + "\n";
}

export interface ExportResult {
  kind: string;
  path: string;
  status: "written" | "unchanged" | "drift";
  entries: number;
}

// Write a view to a path outside the vault as a regular file (firstmate treats
// a symlinked memory file as unsafe, by design). If the file was edited since
// brain last wrote it, refuse: those edits are not in any entry yet, and
// overwriting them would lose them. `force` is for after they are captured.
export function exportView(store: Store, cfg: Config, target: ExportTarget, force = false): ExportResult {
  const entries = listEntries(store, cfg, { kind: target.kind }).filter((entry) => inReadScope(store, cfg, entry.path));
  const content = renderView(entries, target.header);
  const base = { kind: target.kind, path: target.path, entries: entries.length };

  const key = `export:${target.path}`;
  const current = existsSync(target.path) ? readFileSync(target.path, "utf8") : null;
  if (current === content) {
    store.setMeta(key, sha(content));
    recordExported(store, target.path, entries);
    return { ...base, status: "unchanged" };
  }
  const lastWritten = store.getMeta(key);
  if (current !== null && !force && sha(current) !== lastWritten) return { ...base, status: "drift" };

  mkdirSync(dirname(target.path), { recursive: true });
  const tmp = `${target.path}.brain-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, target.path); // atomic: a reader never sees half a file
  store.setMeta(key, sha(content));
  recordExported(store, target.path, entries);
  return { ...base, status: "written" };
}

// Which entries brain last wrote to a path. Like the export hash, it lives only
// in the index: losing it means import proposes no retirements, never a wrong one.
function recordExported(store: Store, path: string, entries: Entry[]): void {
  store.setMeta(`export-entries:${path}`, JSON.stringify(entries.map((e) => e.path)));
}

function exportedPaths(store: Store, path: string): Set<string> {
  try {
    const paths = JSON.parse(store.getMeta(`export-entries:${path}`) ?? "[]") as unknown;
    return new Set(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : []);
  } catch {
    return new Set();
  }
}

// Split an existing memory file into entries: one per top-level list item
// (with its indented continuation lines), one per free-standing paragraph.
// Headings become tags. HTML comments — stow's tier markers and file
// pointers — are dropped from titles. Matching title-and-body occurrences
// with active entries of this kind are skipped, so surplus identical list
// items remain separate entries without duplicating what another machine captured.
export function parseImport(markdown: string): { title: string; body: string; tags: string[] }[] {
  const items: { title: string; body: string; tags: string[] }[] = [];
  let section: string | null = null;
  let current: string[] | null = null;
  let currentTags: string[] = [];

  const flush = () => {
    if (!current) return;
    const [first = "", ...rest] = current;
    const title = stripComments(first).trim();
    const body = rest.map((l) => l.replace(/^ {2,4}|^\t/, "")).join("\n").trim();
    if (title) items.push({ title, body: stripComments(body).trim(), tags: currentTags });
    current = null;
  };

  const text = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, "").replace(/\r\n/g, "\n");
  for (const line of text.split("\n")) {
    const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    const bullet = /^[-*+]\s+(.*)$/.exec(line) ?? /^\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      section = slug(heading[1]!);
    } else if (bullet) {
      flush();
      current = [bullet[1]!];
      currentTags = section ? [section] : [];
    } else if (!line.trim()) {
      // A blank line ends nothing: an indented line after it still continues the item.
    } else if (/^\s/.test(line) && current) {
      current.push(line);
    } else if (/^<!--.*-->\s*$/.test(line.trim())) {
      // file pointer or standalone marker
    } else {
      flush();
      current = [line];
      currentTags = section ? [section] : [];
    }
  }
  flush();
  return items;
}

export function importFile(
  store: Store,
  cfg: Config,
  kind: string,
  file: string,
): { added: string[]; skipped: number; retirementCandidates: RetirementCandidate[]; replacementCandidates: ReplacementCandidate[] } {
  const source = readFileSync(file, "utf8");
  const entryKind = slug(kind);
  const activeEntries = listEntries(store, cfg, { kind: entryKind }).filter((entry) => inReadScope(store, cfg, entry.path));
  const items = parseImport(source);
  // Only an entry brain exported to this file can have been removed from it; an
  // active entry the file never held is not evidence of anything.
  const exported = exportedPaths(store, file);
  const exportedEntries = activeEntries
    .filter((entry) => exported.has(entry.path))
    .sort((a, b) => a.created.localeCompare(b.created) || a.path.localeCompare(b.path));
  const itemsByContent = new Map<string, (typeof items)>();
  for (const item of items) {
    const key = importKey(item);
    itemsByContent.set(key, [...(itemsByContent.get(key) ?? []), item]);
  }
  const matchedExportItems = new Set<(typeof items)[number]>();
  const missing = exportedEntries.filter((entry) => {
    const key = importKey(entry);
    const item = itemsByContent.get(key)?.shift();
    if (!item) return true;
    matchedExportItems.add(item);
    return false;
  });
  const surplusItems = items.filter((item) => !matchedExportItems.has(item));
  // A missing entry whose title is still in the file was reworded, not removed.
  // Its new text is not added: `log replace` records it and retires the old one.
  const exportedByTitle = new Map<string, Entry[]>();
  for (const entry of missing) {
    const key = titleKey(entry);
    exportedByTitle.set(key, [...(exportedByTitle.get(key) ?? []), entry]);
  }
  const newByTitle = new Map<string, (typeof items)>();
  for (const item of surplusItems) {
    const key = titleKey(item);
    newByTitle.set(key, [...(newByTitle.get(key) ?? []), item]);
  }
  const retirementCandidates: RetirementCandidate[] = [];
  const replacementCandidates: ReplacementCandidate[] = [];
  const reworded = new Set<(typeof items)[number]>();
  for (const entry of missing) {
    const key = titleKey(entry);
    const newItems = newByTitle.get(key) ?? [];
    if (!newItems.length) {
      retirementCandidates.push({ path: entry.path, title: entry.title, body: entry.body });
      continue;
    }
    if ((exportedByTitle.get(key) ?? []).length !== 1 || newItems.length !== 1) {
      retirementCandidates.push({ path: entry.path, title: entry.title, body: entry.body, reason: "ambiguous-title" });
      continue;
    }
    const item = newItems[0]!;
    reworded.add(item);
    replacementCandidates.push({
      path: entry.path,
      title: entry.title,
      body: entry.body,
      replacement: { title: item.title, body: item.body },
    });
  }
  const added: string[] = [];
  let skipped = matchedExportItems.size;
  const activeCounts = new Map<string, number>();
  for (const entry of activeEntries) {
    if (exported.has(entry.path)) continue;
    const key = importKey(entry);
    activeCounts.set(key, (activeCounts.get(key) ?? 0) + 1);
  }
  // A millisecond apart and ending now, so the view (oldest first) keeps the
  // file's original order and nothing imported sorts after a later entry.
  const base = Date.now() - items.length;
  items.forEach((item, i) => {
    if (matchedExportItems.has(item) || reworded.has(item)) return;
    const key = importKey(item);
    const count = activeCounts.get(key) ?? 0;
    if (count) {
      activeCounts.set(key, count - 1);
      skipped++;
      return;
    }
    added.push(addEntry(store.vault, cfg, { kind, ...item, created: new Date(base + i) }));
  });
  // What was just imported is now captured, so exporting over this file is no
  // longer a loss — unless a rewording still waits for `log replace`.
  if (!retirementCandidates.length && !replacementCandidates.length) store.setMeta(`export:${file}`, sha(source));
  return { added, skipped, retirementCandidates, replacementCandidates };
}

function stripComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "").replace(/[ \t]+$/gm, "");
}

function titleKey(entry: { title: string }): string {
  return entry.title.replace(/\s+/g, " ").trim();
}

// Title plus body is an entry's content identity.
function importKey(entry: { title: string; body: string }): string {
  const title = titleKey(entry);
  const body = entry.body.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
  return `${title}\n${body}`;
}

export function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
