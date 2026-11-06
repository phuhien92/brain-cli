import { loadConfig } from "../config.js";
import { brainPaths, describePaths, PATH_NAMES, type PathName } from "../paths.js";
import { CliError, type Handler } from "./shared.js";

/** `brain path [name]`: where brain keeps things. Never opens the index. */
export const pathCommand: Handler = (args, flags, ctx) => {
  const { out, print, findVault } = ctx;
  // Before Store.open on purpose: printing a location must not create it.
  const name = args[0];
  if (args.length > 1 || (name !== undefined && !(PATH_NAMES as readonly string[]).includes(name))) {
    throw new CliError("usage", `usage: brain path [${PATH_NAMES.join("|")}]`, 2, { names: [...PATH_NAMES] });
  }
  const vault = findVault(flags.vault);
  const cfg = loadConfig(vault, { as: flags.as });
  const all = describePaths(brainPaths(vault, cfg.logDir));
  const as = cfg.as ? { as: cfg.as.name } : {};
  if (name) {
    const p = all[name as PathName];
    print(out, "path", { name, ...p, ...as }, null, () => p.path);
  } else {
    const width = Math.max(...PATH_NAMES.map((n) => n.length));
    print(out, "path", { paths: all, ...as }, null, () =>
      PATH_NAMES.map((n) => `${n.padEnd(width)}  ${all[n].path}${all[n].exists ? "" : "  (not created yet)"}`).join("\n"),
    );
  }
  return 0;
};
