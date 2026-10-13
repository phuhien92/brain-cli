// How long a note stays true.
//
// Every note can have a category; time-bound categories have a review window.
// A note's state comes from two places, latest wins:
//   1. its own frontmatter, if the user wrote it: category, as-of, reviewed,
//      archived (or status: archived);
//   2. lifecycle events in the log (log/lifecycle/), written by
//      `brain lifecycle set|review|archive|restore`.
// Events rather than frontmatter edits keep brain's "create, never edit" rule:
// two machines reviewing notes never edit the same file, and every change
// leaves an audit trail.
import { addEntry, LIFECYCLE_KIND, RETIRE_ACTION } from "./log.js";
export const CATEGORIES = ["memory", "identity", "preference", "principle", "research", "current-state", "news"];
// Days until a time-bound note should be re-confirmed. null = enduring.
export const DEFAULT_WINDOWS = {
    memory: null,
    identity: null,
    preference: null,
    principle: null,
    research: 180,
    "current-state": 30,
    news: 14,
};
export function today() {
    const fixed = process.env.BRAIN_TODAY; // tests and reproducible reports
    if (fixed && isDate(fixed))
        return fixed;
    return new Date().toISOString().slice(0, 10);
}
export function isDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
}
function addDays(date, days) {
    return new Date(Date.parse(date + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
}
export function windows(cfg) {
    return { ...DEFAULT_WINDOWS, ...cfg.lifecycleWindows };
}
// The state of every note that has any lifecycle information.
export function lifecycleStates(store, cfg) {
    const states = new Map();
    const blank = (path) => ({
        path, category: null, asOf: null, reviewed: null, archived: false, reason: null, due: null, overdue: false, problems: [],
    });
    const eventDir = `${cfg.logDir}/${LIFECYCLE_KIND}/`;
    const rows = store.db.prepare("SELECT path, frontmatter FROM notes").all();
    const events = [];
    for (const r of rows) {
        const fm = JSON.parse(r.frontmatter);
        if (r.path.startsWith(eventDir)) {
            // Log-entry retirements share the append-only lifecycle folder but are
            // handled by log views, not by note freshness state.
            if (fm.action !== RETIRE_ACTION && typeof fm.target === "string") {
                events.push({ created: String(fm.created ?? ""), path: r.path, fm });
            }
            continue;
        }
        const category = fm.category;
        const asOf = fm["as-of"] ?? fm.as_of ?? fm.asOf;
        const archived = fm.archived === true || fm.status === "archived";
        if (category === undefined && asOf === undefined && fm.reviewed === undefined && !archived)
            continue;
        const st = blank(r.path);
        if (typeof category === "string") {
            if (CATEGORIES.includes(category))
                st.category = category;
            else
                st.problems.push(`unknown category '${category}' (use ${CATEGORIES.join(", ")})`);
        }
        if (typeof asOf === "string" && isDate(asOf))
            st.asOf = asOf;
        else if (asOf !== undefined)
            st.problems.push(`as-of '${String(asOf)}' is not a YYYY-MM-DD date`);
        if (typeof fm.reviewed === "string" && isDate(fm.reviewed))
            st.reviewed = fm.reviewed;
        st.archived = archived;
        states.set(r.path, st);
    }
    // Apply events oldest first, so the latest wins.
    events.sort((a, b) => a.created.localeCompare(b.created) || a.path.localeCompare(b.path));
    for (const e of events) {
        const target = String(e.fm.target);
        const st = states.get(target) ?? blank(target);
        const action = e.fm.action;
        if (action === "set") {
            if (typeof e.fm.category === "string" && CATEGORIES.includes(e.fm.category)) {
                st.category = e.fm.category;
            }
            if (typeof e.fm["as-of"] === "string")
                st.asOf = e.fm["as-of"];
        }
        else if (action === "review") {
            if (typeof e.fm.on === "string")
                st.reviewed = e.fm.on;
            if (typeof e.fm["as-of"] === "string")
                st.asOf = e.fm["as-of"];
        }
        else if (action === "archive") {
            st.archived = true;
            st.reason = typeof e.fm.reason === "string" ? e.fm.reason : null;
        }
        else if (action === "restore") {
            st.archived = false;
            st.reason = null;
        }
        states.set(target, st);
    }
    const w = windows(cfg);
    const now = today();
    for (const st of states.values()) {
        const window = st.category ? w[st.category] : null;
        const base = [st.reviewed, st.asOf].filter((d) => !!d).sort().pop() ?? null;
        if (window !== null && window !== undefined) {
            if (base) {
                st.due = addDays(base, window);
                st.overdue = !st.archived && st.due < now;
            }
            else {
                st.problems.push(`${st.category} is time-bound but has no as-of or review date`);
            }
        }
    }
    return states;
}
// Record a lifecycle change as a new log entry (never an edit of the note).
export function recordLifecycle(vault, cfg, target, change) {
    const fields = { target, action: change.action };
    if (change.action === "set") {
        fields.category = change.category;
        if (change.asOf)
            fields["as-of"] = change.asOf;
    }
    else if (change.action === "review") {
        fields.on = change.on;
        if (change.asOf)
            fields["as-of"] = change.asOf;
    }
    else if (change.action === "archive") {
        fields.reason = change.reason;
    }
    const title = change.action === "set"
        ? `${target}: ${change.category}${change.asOf ? ` as of ${change.asOf}` : ""}`
        : change.action === "review"
            ? `${target}: reviewed ${change.on}`
            : change.action === "archive"
                ? `${target}: archived`
                : `${target}: restored`;
    return addEntry(vault, cfg, {
        kind: LIFECYCLE_KIND,
        title,
        body: change.action === "archive" ? change.reason : undefined,
        fields,
    });
}
