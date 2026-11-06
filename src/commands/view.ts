import { inReadScope, inScope, slug } from "../config.js";
import { listEntries, renderView } from "../log.js";
import { CliError, type Handler } from "./shared.js";

/** `brain view <kind>`: one log kind rendered as markdown. */
export const viewCommand: Handler = (args, _flags, ctx) => {
  const { vault, cfg, scope, permit, store, index } = ctx.vault!;
  const kind = slug(args[0] ?? "");
  if (!kind) throw new CliError("usage", "usage: brain view <kind>", 2);
  if (cfg.as) permit(inScope(`${cfg.logDir}/${kind}/`, scope), `read '${kind}' entries`);
  const entries = listEntries(store, cfg, { kind }).filter((entry) => inReadScope(store, cfg, entry.path, scope));
  const markdown = renderView(entries);
  ctx.print(ctx.out, "view", { kind, entries: entries.length, markdown }, { vault, index }, () => markdown);
  return 0;
};
