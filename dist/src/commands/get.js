// `brain get`.
import { inReadScope } from "../config.js";
import { lifecycleStates } from "../lifecycle.js";
import { brief, formatMeta, extractSections } from "./format.js";
import { CliError } from "./shared.js";
export const getCommand = (args, flags, ctx) => {
    const { out, print } = ctx;
    const { vault, cfg, scope, store, index } = ctx.vault;
    const command = "get";
    const ref = args.join(" ").trim();
    if (!ref)
        throw new CliError("usage", "get needs a note: brain get <path|name|title>", 2);
    // Out-of-scope notes are reported as not found, not as forbidden:
    // a restricted caller should not learn what else the vault holds.
    const matches = store.resolve(ref).filter((p) => inReadScope(store, cfg, p, scope));
    if (matches.length === 0)
        throw new CliError("not_found", `no note matches '${ref}'`, 3);
    if (matches.length > 1) {
        throw new CliError("ambiguous", `'${ref}' matches ${matches.length} notes — use a path`, 4, {
            candidates: matches,
        });
    }
    const note = { ...store.get(matches[0]), lifecycle: brief(lifecycleStates(store, cfg).get(matches[0])) };
    const maxLines = flags.lines === undefined ? undefined : Number(flags.lines);
    if (maxLines !== undefined && (!Number.isInteger(maxLines) || maxLines < 1)) {
        throw new CliError("usage", "--lines must be a positive integer", 2);
    }
    if (maxLines !== undefined && !flags.section?.length) {
        const all = note.content.split("\n");
        const content = all.slice(0, maxLines).join("\n") + "\n";
        const truncated = all.length > maxLines;
        print(out, command, { ...note, content, truncated }, { vault, index }, () => content);
        return 0;
    }
    if (flags.section?.length) {
        const { content, found, missing } = extractSections(note.content, flags.section, maxLines);
        if (!found.length) {
            throw new CliError("not_found", `no section in ${note.path} matches ${flags.section.map((x) => `'${x}'`).join(", ")}`, 3, {
                headings: note.headings,
            });
        }
        const data = { ...note, content, sections: found, missing };
        print(out, command, data, { vault, index }, () => content + (missing.length ? `\n(no section matched: ${missing.join(", ")})` : ""));
        return 0;
    }
    const data = flags.meta ? { ...note, content: undefined } : note;
    print(out, command, data, { vault, index }, () => (flags.meta ? formatMeta(note) : note.content));
    return 0;
};
