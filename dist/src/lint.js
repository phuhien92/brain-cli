// Vault health: what a person (or an agent) would want to fix.
//
// Every rule reads the index and the file tree; none changes anything. A
// finding names the file, the rule and what to do. Severities: "warn" for
// things that make answers wrong or links dead, "info" for housekeeping.
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { inScope, readScope } from "./config.js";
import { LIFECYCLE_KIND, lifecycleStates } from "./lifecycle.js";
import { basename } from "./note.js";
// Names sync services give the loser of a conflict. Each must match a file
// whose "original" also exists, so a note honestly titled "Plan 2" is fine.
const CONFLICT_PATTERNS = [
    { re: /^(.*) \d+(\.md)$/i, service: "iCloud" }, // "Note 2.md"
    { re: /^(.*) \([^)]*conflicted copy[^)]*\)(\.md)$/i, service: "Dropbox/Obsidian Sync" },
    { re: /^(.*)\.sync-conflict-[^.]+(\.md)$/i, service: "Syncthing" },
];
export function lint(store, cfg) {
    const findings = [];
    const scope = readScope(cfg);
    const logPrefix = `${cfg.logDir}/`;
    const notes = store.db.prepare("SELECT path, title, aliases FROM notes").all().filter((n) => inScope(n.path, scope));
    const allPaths = new Set(notes.map((n) => n.path));
    const lower = (s) => s.toLowerCase();
    // Resolution tables, the way Obsidian resolves [[links]].
    const byPath = new Map(notes.map((n) => [lower(n.path), n.path]));
    const byName = new Map();
    const byTitle = new Map();
    for (const n of notes) {
        byName.set(lower(basename(n.path)), n.path);
        byTitle.set(lower(n.title), n.path);
        for (const a of JSON.parse(n.aliases))
            byTitle.set(lower(a), n.path);
    }
    // Every non-note file (attachments, .excalidraw boards, PDFs), findable by
    // vault path, file name, or file name without its extension.
    const files = new Set();
    for (const f of walkFiles(store.vault)) {
        const name = lower(f.split("/").pop());
        files.add(lower(f)).add(name).add(name.replace(/\.[^.]+$/, ""));
    }
    const resolve = (target) => {
        const t = lower(target.replace(/\\/g, "/").replace(/^\.?\//, ""));
        const withExt = t.endsWith(".md") ? t : `${t}.md`;
        const exact = byPath.get(t) ?? byPath.get(withExt);
        if (exact)
            return exact;
        const suffix = notes.find((n) => lower(n.path).endsWith(`/${withExt}`));
        if (suffix)
            return suffix.path;
        const name = basename(t);
        return byName.get(name) ?? byTitle.get(name) ?? byTitle.get(t) ?? null;
    };
    // broken-link, and inbound counts for orphans
    const inbound = new Map();
    const links = store.db.prepare("SELECT src, target FROM links").all();
    const reported = new Set();
    for (const l of links) {
        if (!allPaths.has(l.src))
            continue;
        const hit = resolve(l.target);
        if (hit) {
            inbound.set(hit, (inbound.get(hit) ?? 0) + 1);
            continue;
        }
        const isAttachment = /\.[a-z0-9]+$/i.test(l.target) && !/\.md$/i.test(l.target);
        const t = lower(l.target.replace(/\\/g, "/").replace(/^\.?\//, ""));
        if (files.has(t) || files.has(t.split("/").pop()))
            continue; // a file, by path, name, or name without extension
        const key = `${l.src}\n${l.target}`;
        if (reported.has(key))
            continue;
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
        if (!n.path.includes("/") || n.path.startsWith(logPrefix))
            continue;
        if (!inbound.get(n.path)) {
            findings.push({ rule: "orphan", severity: "info", path: n.path, message: "no note links here" });
        }
    }
    // conflict-copy: a sync service kept both sides of a conflict
    for (const n of notes) {
        const file = n.path.split("/").pop();
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
        if (!inScope(st.path, scope))
            continue;
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
        for (const p of st.problems)
            findings.push({ rule: "lifecycle", severity: "warn", path: st.path, message: p });
    }
    // max-lines: per-file limits the vault sets for itself
    for (const [path, max] of Object.entries(cfg.lintMaxLines)) {
        if (!allPaths.has(path))
            continue;
        const content = store.get(path)?.content ?? "";
        const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0); // as `wc -l` counts
        if (lines > max) {
            findings.push({ rule: "max-lines", severity: "warn", path, message: `${lines} lines, over this vault's limit of ${max}` });
        }
    }
    const order = { warn: 0, info: 1 };
    return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.rule.localeCompare(b.rule) || a.path.localeCompare(b.path));
}
function* walkFiles(root, dir = root) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules")
            continue;
        const full = join(dir, e.name);
        if (e.isDirectory())
            yield* walkFiles(root, full);
        else if (e.isFile() && !e.name.toLowerCase().endsWith(".md"))
            yield relative(root, full).split(sep).join("/");
    }
}
