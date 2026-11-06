// `brain ingest`.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ingest } from "../source.js";
import { CliError } from "./shared.js";
export const ingestCommand = (args, flags, ctx) => {
    const { out, print } = ctx;
    const { vault, cfg, permit, store } = ctx.vault;
    let index = ctx.vault.index;
    const command = "ingest";
    if (args.length !== 1)
        throw new CliError("usage", "usage: brain ingest <file> [--title <title>] [--tag <tag>]", 2);
    if (cfg.as)
        permit(false, "ingest sources");
    const file = resolve(args[0]);
    if (!existsSync(file))
        throw new CliError("not_found", `no file at ${file}`, 3);
    const result = ingest(vault, cfg, { file, title: flags.title, tags: flags.tag });
    index = store.refresh();
    print(out, command, result, { vault, index }, () => result.new ? result.path : `${result.path} (already ingested)`);
    return 0;
};
