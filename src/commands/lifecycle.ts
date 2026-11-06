// `brain lifecycle`.
import { join, resolve } from "node:path";
import { inReadScope } from "../config.js";
import { CATEGORIES, isDate, lifecycleStates, recordLifecycle, today, windows, type Category } from "../lifecycle.js";
import { LIFECYCLE_KIND } from "../log.js";
import { CliError, type Handler } from "./shared.js";

export const lifecycleCommand: Handler = (args, flags, ctx) => {
  const { out, print } = ctx;
  const { vault, cfg, scope, permit, store } = ctx.vault!;
  let index = ctx.vault!.index;
  const [sub, ...rest] = args;
  const states = lifecycleStates(store, cfg);
  if (sub === "status") {
    if (rest.length) throw new CliError("usage", "usage: brain lifecycle status [--due]", 2);
    const list = [...states.values()]
      .filter((st) => inReadScope(store!, cfg, st.path, scope))
      .filter((st) => !flags.due || st.overdue)
      .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.path.localeCompare(b.path));
    print(out, "lifecycle.status", { today: today(), notes: list }, { vault, index }, () =>
      list.length
        ? list
            .map((st) =>
              `${st.overdue ? "OVERDUE " : st.archived ? "archived" : "        "} ${(st.category ?? "-").padEnd(13)} due ${st.due ?? "-         "}  ${st.path}` +
              (st.problems.length ? `\n         ! ${st.problems.join("; ")}` : ""),
            )
            .join("\n")
        : flags.due
          ? "nothing is overdue"
          : "no notes have lifecycle data yet — start with: brain lifecycle set <note> --category <category>",
    );
    return 0;
  }
  if (!["set", "review", "archive", "restore"].includes(sub ?? "")) {
    throw new CliError("usage", "usage: brain lifecycle set|review|archive|restore <note> … | lifecycle status [--due]", 2);
  }
  const ref = rest.join(" ").trim();
  if (!ref) throw new CliError("usage", `usage: brain lifecycle ${sub} <note>`, 2);
  const matches = store.resolve(ref).filter((p) => inReadScope(store!, cfg, p, scope));
  if (matches.length === 0) throw new CliError("not_found", `no note matches '${ref}'`, 3);
  if (matches.length > 1) {
    throw new CliError("ambiguous", `'${ref}' matches ${matches.length} notes — use a path`, 4, { candidates: matches });
  }
  const target = matches[0]!;
  if (cfg.as) permit(cfg.as.write.includes(LIFECYCLE_KIND), `record lifecycle changes (add "${LIFECYCLE_KIND}" to its write kinds)`);
  const date = (flag: string, v: string | undefined) => {
    if (v !== undefined && !isDate(v)) throw new CliError("usage", `--${flag} must be a YYYY-MM-DD date`, 2);
    return v;
  };
  let change;
  if (sub === "set") {
    const category = flags.category;
    if (!category || !(CATEGORIES as readonly string[]).includes(category)) {
      throw new CliError("usage", `--category must be one of: ${CATEGORIES.join(", ")}`, 2);
    }
    const asOf = date("as-of", flags["as-of"]);
    const w = windows(cfg)[category as Category];
    if (w !== null && !asOf && !states.get(target)?.asOf) {
      throw new CliError("usage", `${category} is time-bound: give --as-of YYYY-MM-DD (when the note was true)`, 2);
    }
    change = { action: "set" as const, category: category as Category, asOf };
  } else if (sub === "review") {
    change = { action: "review" as const, on: date("on", flags.on) ?? today(), asOf: date("as-of", flags["as-of"]) };
  } else if (sub === "archive") {
    if (!flags.reason?.trim()) throw new CliError("usage", 'archive needs --reason "..." (why it is no longer active)', 2);
    change = { action: "archive" as const, reason: flags.reason.trim().replace(/\s+/g, " ") };
  } else {
    change = { action: "restore" as const };
  }
  const entry = recordLifecycle(vault, cfg, target, change);
  index = store.refresh();
  const st = lifecycleStates(store, cfg).get(target)!;
  print(out, `lifecycle.${sub}`, { entry, state: st }, { vault, index }, () =>
    `${target}: ${st.archived ? "archived" : st.category ?? "no category"}${st.due ? `, next review ${st.due}` : ""}  (${entry})`,
  );
  return 0;
};
