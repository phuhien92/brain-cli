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

import type { Config } from "./config.js";
import { addEntry, LIFECYCLE_KIND, RETIRE_ACTION } from "./log.js";
import type { Store } from "./store.js";

export const CATEGORIES = ["memory", "identity", "preference", "principle", "research", "current-state", "news"] as const;
export type Category = (typeof CATEGORIES)[number];

// Days until a time-bound note should be re-confirmed. null = enduring.
export const DEFAULT_WINDOWS: Record<Category, number | null> = {
  memory: null,
  identity: null,
  preference: null,
  principle: null,
  research: 180,
  "current-state": 30,
  news: 14,
};

export interface LifecycleState {
  path: string;
  category: Category | null;
  asOf: string | null; // when the content was true
  reviewed: string | null; // when it was last confirmed
  archived: boolean;
  reason: string | null;
  due: string | null; // next review date; null if enduring or no date to count from
  overdue: boolean;
  problems: string[]; // e.g. an unknown category, a time-bound note with no date
}

export function today(): string {
  const fixed = process.env.BRAIN_TODAY; // tests and reproducible reports
  if (fixed && isDate(fixed)) return fixed;
  return new Date().toISOString().slice(0, 10);
}

export function isDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
}

export function windows(cfg: Config): Record<Category, number | null> {
  return { ...DEFAULT_WINDOWS, ...cfg.lifecycleWindows };
}

// The state of every note that has any lifecycle information.
export function lifecycleStates(store: Store, cfg: Config): Map<string, LifecycleState> {
  const states = new Map<string, LifecycleState>();
  const blank = (path: string): LifecycleState => ({
    path, category: null, asOf: null, reviewed: null, archived: false, reason: null, due: null, overdue: false, problems: [],
  });
  const eventDir = `${cfg.logDir}/${LIFECYCLE_KIND}/`;

  const rows = store.db.prepare("SELECT path, frontmatter FROM notes").all() as { path: string; frontmatter: string }[];
  const events: { created: string; path: string; fm: Record<string, unknown> }[] = [];
  for (const r of rows) {
    const fm = JSON.parse(r.frontmatter) as Record<string, unknown>;
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
    if (category === undefined && asOf === undefined && fm.reviewed === undefined && !archived) continue;
    const st = blank(r.path);
    if (typeof category === "string") {
      if ((CATEGORIES as readonly string[]).includes(category)) st.category = category as Category;
      else st.problems.push(`unknown category '${category}' (use ${CATEGORIES.join(", ")})`);
    }
    if (typeof asOf === "string" && isDate(asOf)) st.asOf = asOf;
    else if (asOf !== undefined) st.problems.push(`as-of '${String(asOf)}' is not a YYYY-MM-DD date`);
    if (typeof fm.reviewed === "string" && isDate(fm.reviewed)) st.reviewed = fm.reviewed;
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
      if (typeof e.fm.category === "string" && (CATEGORIES as readonly string[]).includes(e.fm.category)) {
        st.category = e.fm.category as Category;
      }
      if (typeof e.fm["as-of"] === "string") st.asOf = e.fm["as-of"];
    } else if (action === "review") {
      if (typeof e.fm.on === "string") st.reviewed = e.fm.on;
      if (typeof e.fm["as-of"] === "string") st.asOf = e.fm["as-of"];
    } else if (action === "archive") {
      st.archived = true;
      st.reason = typeof e.fm.reason === "string" ? e.fm.reason : null;
    } else if (action === "restore") {
      st.archived = false;
      st.reason = null;
    }
    states.set(target, st);
  }

  const w = windows(cfg);
  const now = today();
  for (const st of states.values()) {
    const window = st.category ? w[st.category] : null;
    const base = [st.reviewed, st.asOf].filter((d): d is string => !!d).sort().pop() ?? null;
    if (window !== null && window !== undefined) {
      if (base) {
        st.due = addDays(base, window);
        st.overdue = !st.archived && st.due < now;
      } else {
        st.problems.push(`${st.category} is time-bound but has no as-of or review date`);
      }
    }
  }
  return states;
}

export type LifecycleAction =
  | { action: "set"; category: Category; asOf?: string }
  | { action: "review"; on: string; asOf?: string }
  | { action: "archive"; reason: string }
  | { action: "restore" };

// Record a lifecycle change as a new log entry (never an edit of the note).
export function recordLifecycle(vault: string, cfg: Config, target: string, change: LifecycleAction): string {
  const fields: Record<string, string> = { target, action: change.action };
  if (change.action === "set") {
    fields.category = change.category;
    if (change.asOf) fields["as-of"] = change.asOf;
  } else if (change.action === "review") {
    fields.on = change.on;
    if (change.asOf) fields["as-of"] = change.asOf;
  } else if (change.action === "archive") {
    fields.reason = change.reason;
  }
  const title =
    change.action === "set"
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
