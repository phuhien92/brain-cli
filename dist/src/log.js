// The append-only log: one markdown file per entry.
//
// This is what makes the vault safe to sync between machines with plain git.
// Two machines appending to one learnings.md produce a merge conflict on the
// first sync; two machines each creating a new file never do. Every write in
// this module creates a file that did not exist — none edits one.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { slug } from "./config.js";
export const RETIRE_ACTION = "retire";
export const LIFECYCLE_KIND = "lifecycle";
export function addEntry(vault, cfg, input) {
    const kind = slug(input.kind);
    if (!kind)
        throw new Error("an entry needs a kind, e.g. 'learning'");
    const title = input.title.replace(/\s+/g, " ").trim();
    if (!title)
        throw new Error("an entry needs a title");
    const created = input.created ?? new Date();
    const iso = created.toISOString(); // millisecond precision: the view's order is creation order
    const day = iso.slice(0, 10);
    const name = `${day}-${cfg.machine}-${slug(title) || "entry"}`;
    const dir = join(vault, ...cfg.logDir.split("/"), kind);
    mkdirSync(dir, { recursive: true });
    const tags = [...new Set((input.tags ?? []).map((t) => t.replace(/^#/, "").trim().toLowerCase()).filter(Boolean))];
    const lines = ["---", `kind: ${kind}`, `created: ${iso}`, `machine: ${cfg.machine}`];
    if (tags.length)
        lines.push(`tags: [${tags.join(", ")}]`);
    for (const [key, value] of Object.entries(input.fields ?? {})) {
        if (!/^[a-z][a-z0-9-]*$/.test(key))
            throw new Error(`invalid entry field ${key}`);
        lines.push(`${key}: ${JSON.stringify(value)}`);
    }
    lines.push("---", `# ${title}`, "");
    const body = (input.body ?? "").replace(/\r\n/g, "\n").trim();
    const content = lines.join("\n") + (body ? `\n${body}\n` : "");
    // 'wx' fails if the file exists, so a same-second, same-title entry gets a
    // suffix instead of silently replacing the first.
    for (let n = 1;; n++) {
        const file = join(dir, n === 1 ? `${name}.md` : `${name}-${n}.md`);
        try {
            writeFileSync(file, content, { flag: "wx" });
            return `${cfg.logDir}/${kind}/${file.slice(dir.length + 1)}`;
        }
        catch (err) {
            if (err.code !== "EEXIST")
                throw err;
        }
    }
}
export function listEntries(store, cfg, opts = {}) {
    const rows = store.db
        .prepare(`SELECT path, title, frontmatter, tags FROM notes
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
        LIMIT ?`)
        .all(cfg.logDir.replace(/[\\%_]/g, (c) => `\\${c}`) + "/%", opts.kind ?? null, opts.kind ?? null, opts.includeRetired ? 1 : 0, `${cfg.logDir}/${LIFECYCLE_KIND}`.replace(/[\\%_]/g, (c) => `\\${c}`) + "/%", opts.limit ?? -1);
    return rows.map((r) => {
        const fm = JSON.parse(r.frontmatter);
        const raw = readFileSync(join(store.vault, ...r.path.split("/")), "utf8");
        return {
            path: r.path,
            kind: String(fm.kind),
            title: r.title,
            created: String(fm.created ?? ""),
            machine: String(fm.machine ?? ""),
            tags: JSON.parse(r.tags),
            body: entryBody(raw),
        };
    });
}
// Record a retirement as a separate lifecycle entry. Multiple machines may
// retire the same target; each event is valid and no existing file is touched.
export function recordRetirement(vault, cfg, target, opts = {}) {
    const fields = { target, action: RETIRE_ACTION };
    if (opts.reason)
        fields.reason = opts.reason;
    if (opts.replacement)
        fields.replacement = opts.replacement;
    return addEntry(vault, cfg, {
        kind: LIFECYCLE_KIND,
        title: `${target}: retired`,
        body: opts.reason,
        fields,
    });
}
// The body after the frontmatter and the leading "# title" line.
function entryBody(raw) {
    return raw
        .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, "")
        .replace(/^\s*#[ \t]+[^\n]*\n?/, "")
        .trim();
}
// A view is every entry of one kind, oldest first, as a markdown list: the
// shape tools that predate brain (firstmate's learnings.md) already read.
export function renderView(entries, header) {
    const sorted = [...entries].sort((a, b) => a.created.localeCompare(b.created) || a.path.localeCompare(b.path));
    // Two machines that each imported the same learning before either synced
    // hold two entry files with the same text. Both files stay (deleting one is a
    // write a sync could fight over); the view shows the oldest once.
    const seen = new Set();
    const unique = sorted.filter((e) => {
        const key = renderKey(e);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
    const out = [];
    if (header)
        out.push(header);
    const kind = sorted[0]?.kind ?? "entry";
    out.push(`<!-- generated by brain from ${unique.length} ${kind} entries; add one with: brain log add ${kind} "<text>" -->`);
    for (const e of unique) {
        out.push(`- ${e.title}`);
        if (e.body)
            for (const line of e.body.split("\n"))
                out.push(line.trim() ? `  ${line}` : "");
    }
    return out.join("\n") + "\n";
}
// Write a view to a path outside the vault as a regular file (firstmate treats
// a symlinked memory file as unsafe, by design). If the file was edited since
// brain last wrote it, refuse: those edits are not in any entry yet, and
// overwriting them would lose them. `force` is for after they are captured.
export function exportView(store, cfg, target, force = false) {
    const entries = listEntries(store, cfg, { kind: target.kind });
    const content = renderView(entries, target.header);
    const base = { kind: target.kind, path: target.path, entries: entries.length };
    const key = `export:${target.path}`;
    const current = existsSync(target.path) ? readFileSync(target.path, "utf8") : null;
    if (current === content) {
        store.setMeta(key, sha(content));
        return { ...base, status: "unchanged" };
    }
    const lastWritten = store.getMeta(key);
    if (current !== null && !force && sha(current) !== lastWritten)
        return { ...base, status: "drift" };
    mkdirSync(dirname(target.path), { recursive: true });
    const tmp = `${target.path}.brain-tmp-${process.pid}`;
    writeFileSync(tmp, content);
    renameSync(tmp, target.path); // atomic: a reader never sees half a file
    store.setMeta(key, sha(content));
    return { ...base, status: "written" };
}
// Split an existing memory file into entries: one per top-level list item
// (with its indented continuation lines), one per free-standing paragraph.
// Headings become tags. HTML comments — stow's tier markers and file
// pointers — are dropped from titles. Entries whose title and body already
// exist for this kind are skipped, so importing on a second machine does not
// duplicate what the first already captured.
export function parseImport(markdown) {
    const items = [];
    let section = null;
    let current = null;
    let currentTags = [];
    const flush = () => {
        if (!current)
            return;
        const [first = "", ...rest] = current;
        const title = stripComments(first).trim();
        const body = rest.map((l) => l.replace(/^ {2,4}|^\t/, "")).join("\n").trim();
        if (title)
            items.push({ title, body: stripComments(body).trim(), tags: currentTags });
        current = null;
    };
    const text = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, "").replace(/\r\n/g, "\n");
    for (const line of text.split("\n")) {
        const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
        const bullet = /^[-*+]\s+(.*)$/.exec(line) ?? /^\d+[.)]\s+(.*)$/.exec(line);
        if (heading) {
            flush();
            section = slug(heading[1]);
        }
        else if (bullet) {
            flush();
            current = [bullet[1]];
            currentTags = section ? [section] : [];
        }
        else if (!line.trim()) {
            // A blank line ends nothing: an indented line after it still continues the item.
        }
        else if (/^\s/.test(line) && current) {
            current.push(line);
        }
        else if (/^<!--.*-->\s*$/.test(line.trim())) {
            // file pointer or standalone marker
        }
        else {
            flush();
            current = [line];
            currentTags = section ? [section] : [];
        }
    }
    flush();
    return items;
}
export function importFile(store, cfg, kind, file) {
    const source = readFileSync(file, "utf8");
    const entryKind = slug(kind);
    const allEntries = listEntries(store, cfg, { kind: entryKind, includeRetired: true });
    const activeEntries = listEntries(store, cfg, { kind: entryKind });
    // A retired entry remains recorded: importing a stale generated file must
    // not silently recreate it as a new active entry.
    const existing = new Set(allEntries.map(importKey));
    const added = [];
    let skipped = 0;
    // A millisecond apart and ending now, so the view (oldest first) keeps the
    // file's original order and nothing imported sorts after a later entry.
    const items = parseImport(source);
    const imported = new Set(items.map(importKey));
    const retirementCandidates = activeEntries
        .filter((entry) => !imported.has(importKey(entry)))
        .map(({ path, title, body }) => ({ path, title, body }));
    const base = Date.now() - items.length;
    items.forEach((item, i) => {
        const key = importKey(item);
        if (existing.has(key)) {
            skipped++;
            return;
        }
        existing.add(key);
        added.push(addEntry(store.vault, cfg, { kind, ...item, created: new Date(base + i) }));
    });
    // What was just imported is now captured, so exporting over this file is no
    // longer a loss.
    store.setMeta(`export:${file}`, sha(source));
    return { added, skipped, retirementCandidates };
}
function stripComments(s) {
    return s.replace(/<!--[\s\S]*?-->/g, "").replace(/[ \t]+$/gm, "");
}
function norm(s) {
    return s.toLowerCase().replace(/\s+/g, " ").trim();
}
function renderKey(entry) {
    return `${norm(entry.title)}\n${norm(entry.body)}`;
}
function importKey(entry) {
    const title = entry.title.replace(/\s+/g, " ").trim();
    const body = entry.body.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
    return `${title}\n${body}`;
}
export function sha(s) {
    return createHash("sha256").update(s).digest("hex");
}
