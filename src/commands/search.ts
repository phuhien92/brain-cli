// `brain search`.
import { join } from "node:path";
import { lifecycleStates } from "../lifecycle.js";
import { LIFECYCLE_KIND } from "../log.js";
import { brief, staleMark, stem } from "./format.js";
import { CliError, type Handler } from "./shared.js";

export const searchCommand: Handler = (args, flags, ctx) => {
  const { out, print } = ctx;
  const { vault, cfg, scope, store, index } = ctx.vault!;
  const command = "search";
  const query = args.join(" ").trim();
  if (!query) throw new CliError("usage", "search needs a query: brain search <query>", 2);
  const limit = flags.limit === undefined ? 10 : Number(flags.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new CliError("usage", "--limit must be a positive integer", 2);
  let hits;
  try {
    const states = lifecycleStates(store, cfg);
    const hidden = [...states.values()].filter((st) => st.archived && !flags["include-archived"]).map((st) => st.path);
    hits = store
      .search(query, { limit, path: flags.path, tag: flags.tag?.[0], raw: flags.raw, scope, exclude: hidden, excludePrefix: `${cfg.logDir}/${LIFECYCLE_KIND}/` })
      .map((h) => ({ ...h, lifecycle: brief(states.get(h.path)) }));
  } catch (err) {
    if (flags.raw) throw new CliError("bad_query", `invalid FTS5 query: ${(err as Error).message}`, 2);
    throw err;
  }
  print(out, command, { query, results: hits }, { vault, index }, () =>
    hits.length
      ? hits
          .map((h, i) => `${i + 1}. ${h.path}  (${h.score})${staleMark(h)}\n   ${h.title !== stem(h.path) ? h.title + " — " : ""}${h.snippet}`)
          .join("\n")
      : `no results for '${query}'`,
  );
  return 0;
};
