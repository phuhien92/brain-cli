export function brief(st) {
    if (!st)
        return null;
    return { category: st.category, asOf: st.asOf, reviewed: st.reviewed, due: st.due, overdue: st.overdue, archived: st.archived, reason: st.reason };
}
export function staleMark(h) {
    if (!h.lifecycle)
        return "";
    if (h.lifecycle.archived)
        return "  [archived]";
    return h.lifecycle.overdue ? `  [stale: review was due ${h.lifecycle.due}]` : "";
}
export function formatFindings(findings) {
    const lines = [];
    let rule = "";
    for (const f of findings) {
        if (f.rule !== rule) {
            rule = f.rule;
            const n = findings.filter((x) => x.rule === rule).length;
            lines.push(`${lines.length ? "\n" : ""}${f.severity.toUpperCase()} ${rule} (${n})`);
        }
        lines.push(`  ${f.path}: ${f.message}`);
    }
    return lines.join("\n");
}
export function formatMeta(note) {
    const lines = [`${note.path}`, `title: ${note.title}`];
    if (note.aliases.length)
        lines.push(`aliases: ${note.aliases.join(", ")}`);
    if (note.tags.length)
        lines.push(`tags: ${note.tags.join(", ")}`);
    for (const [k, v] of Object.entries(note.frontmatter)) {
        if (["title", "tags", "aliases", "alias"].includes(k))
            continue;
        lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
    }
    if (note.headings.length)
        lines.push("headings:", ...note.headings.map((h) => `  ${h}`));
    if (note.links.length) {
        lines.push("links:", ...note.links.map((l) => `  [[${l.target}${l.heading ? "#" + l.heading : ""}]]`));
    }
    return lines.join("\n");
}
export function stem(path) {
    return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}
export function extractSections(markdown, wanted, maxLines) {
    const lines = markdown.split("\n");
    const headings = [];
    let fence = null;
    lines.forEach((line, i) => {
        const f = /^(```|~~~)/.exec(line);
        if (f)
            fence = fence === f[1] ? null : (fence ?? f[1]);
        if (fence)
            return;
        const h = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(line);
        if (h)
            headings.push({ line: i, level: h[1].length, text: h[2].trim() });
    });
    const norm = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();
    const picked = new Map();
    const missing = [];
    for (const w of wanted) {
        const exact = headings.findIndex((h) => norm(h.text) === norm(w));
        const idx = exact >= 0 ? exact : headings.findIndex((h) => norm(h.text).startsWith(norm(w)));
        if (idx < 0)
            missing.push(w);
        else
            picked.set(idx, headings[idx].text);
    }
    const order = [...picked.keys()].sort((a, b) => a - b);
    const blocks = order.map((idx) => {
        const h = headings[idx];
        const next = headings.slice(idx + 1).find((n) => n.level <= h.level);
        const end = next ? next.line : lines.length;
        const stop = maxLines === undefined ? end : Math.min(end, h.line + maxLines);
        return lines.slice(h.line, stop).join("\n").trimEnd();
    });
    return { content: blocks.join("\n\n") + (blocks.length ? "\n" : ""), found: order.map((i) => picked.get(i)), missing };
}
