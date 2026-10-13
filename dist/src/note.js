// Parses one markdown note into the fields the index stores.
// Deliberately dependency-free: an Obsidian note's frontmatter is a small,
// predictable YAML subset (scalars, inline lists, block lists), and owning the
// parser keeps `npx brain-cli` a zero-install-cost command for agents.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
export function parseNote(relPath, source) {
    const text = source.replace(/^﻿/, "");
    const fm = FRONTMATTER.exec(text);
    const frontmatter = fm ? parseFrontmatter(fm[1] ?? "") : {};
    const body = fm ? text.slice(fm[0].length) : text;
    const prose = stripCode(body);
    const headings = [];
    for (const m of prose.matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm))
        headings.push(m[1].trim());
    const tags = new Set(listOf(frontmatter.tags).map(normaliseTag));
    // Inline #tags: must start a word and contain a non-digit (Obsidian's rule), so
    // "#1" and URL fragments are not tags.
    for (const m of prose.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu)) {
        tags.add(normaliseTag(m[1]));
    }
    const links = [];
    for (const m of prose.matchAll(/!?\[\[([^\]\n]+?)\]\]/g)) {
        const link = parseWikiLink(m[1]);
        if (link)
            links.push(link);
    }
    // Wiki-links inside frontmatter values (e.g. `related: "[[Other]]"`) count too.
    for (const m of (fm?.[1] ?? "").matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
        const link = parseWikiLink(m[1]);
        if (link)
            links.push(link);
    }
    const fmTitle = typeof frontmatter.title === "string" && frontmatter.title.trim() ? frontmatter.title.trim() : null;
    const h1 = /^#[ \t]+(.+?)[ \t#]*$/m.exec(prose)?.[1]?.trim() ?? null;
    const title = fmTitle ?? h1 ?? basename(relPath);
    return {
        title,
        frontmatter,
        headings,
        tags: [...tags].filter(Boolean),
        aliases: listOf(frontmatter.aliases ?? frontmatter.alias),
        links,
        body,
    };
}
export function parseWikiLink(inner) {
    // [[target#heading|alias]] — in tables the pipe is escaped as \|
    const [targetPart = ""] = inner.split(/\\?\|/);
    const [rawTarget = "", ...rest] = targetPart.split("#");
    const target = rawTarget.trim();
    const heading = rest.length ? rest.join("#").replace(/^\^/, "").trim() || null : null;
    if (!target)
        return null; // same-note heading link
    return { target, heading };
}
export function basename(relPath) {
    const file = relPath.split("/").pop() ?? relPath;
    return file.replace(/\.md$/i, "");
}
function normaliseTag(tag) {
    return tag.replace(/^#/, "").trim().toLowerCase();
}
function listOf(value) {
    if (value == null)
        return [];
    if (Array.isArray(value))
        return value.map(String).filter(Boolean);
    return String(value)
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}
// Remove fenced and inline code so `#include` or `[[x]]` in a snippet is not
// read as a tag or link. Line count is preserved for fenced blocks.
function stripCode(markdown) {
    return markdown
        .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, (block) => block.replace(/[^\n]/g, " "))
        .replace(/`[^`\n]+`/g, " ");
}
export function parseFrontmatter(yaml) {
    const out = {};
    const lines = yaml.split(/\r?\n/);
    let listKey = null;
    for (const line of lines) {
        if (!line.trim() || line.trimStart().startsWith("#"))
            continue;
        const item = /^\s+-\s*(.*)$/.exec(line) ?? (listKey ? /^-\s+(.*)$/.exec(line) : null);
        if (item && listKey) {
            const current = out[listKey];
            const list = Array.isArray(current) ? current : [];
            const value = scalar(item[1] ?? "");
            if (value !== null && value !== "")
                list.push(String(value));
            out[listKey] = list;
            continue;
        }
        const kv = /^([^\s:#][^:]*?):(?:\s+(.*))?$/.exec(line);
        if (!kv) {
            listKey = null;
            continue;
        }
        const key = kv[1].trim();
        const raw = (kv[2] ?? "").trim();
        if (raw === "") {
            out[key] = [];
            listKey = key;
            continue;
        }
        listKey = null;
        if (raw.startsWith("[") && raw.endsWith("]") && !raw.startsWith("[[")) {
            out[key] = splitInline(raw.slice(1, -1))
                .map((s) => scalar(s))
                .filter((v) => v !== null && v !== "")
                .map(String);
        }
        else {
            out[key] = scalar(raw);
        }
    }
    // A key followed by nothing and no list items is an empty value, not a list.
    for (const [k, v] of Object.entries(out))
        if (Array.isArray(v) && v.length === 0)
            out[k] = null;
    return out;
}
function splitInline(s) {
    const parts = [];
    let buf = "";
    let quote = null;
    for (const ch of s) {
        if (quote) {
            if (ch === quote)
                quote = null;
            buf += ch;
        }
        else if (ch === '"' || ch === "'") {
            quote = ch;
            buf += ch;
        }
        else if (ch === ",") {
            parts.push(buf);
            buf = "";
        }
        else
            buf += ch;
    }
    if (buf.trim())
        parts.push(buf);
    return parts;
}
function scalar(raw) {
    let s = raw.trim();
    if (/^(['"]).*\1$/.test(s))
        return s.slice(1, -1);
    s = s.replace(/\s+#.*$/, ""); // trailing comment on an unquoted value
    if (s === "" || s === "~" || s === "null")
        return null;
    if (s === "true")
        return true;
    if (s === "false")
        return false;
    if (/^-?\d+(\.\d+)?$/.test(s))
        return Number(s);
    return s;
}
