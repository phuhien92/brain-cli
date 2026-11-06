// `brain context`.
import { loadConfig } from "../config.js";
import { context } from "../agent.js";
import { contextHookLines } from "../hooks.js";
import { Store } from "../store.js";
export const contextCommand = async (args, flags, ctx) => {
    const { out, print, findVault } = ctx;
    // Runs inside other tools' session-start hooks: any failure prints nothing
    // and exits 0, so a missing vault never breaks the agent that called it.
    let ctxStore = null;
    try {
        const limit = flags.limit === undefined ? 5 : Math.max(0, Math.min(Number(flags.limit) || 0, 50));
        const vault = findVault(flags.vault);
        const cfg = loadConfig(vault, { as: flags.as });
        ctxStore = Store.open(vault);
        const index = ctxStore.refresh();
        const text = context(ctxStore, cfg, limit, await contextHookLines(vault, cfg));
        print(out, "context", { context: text }, { vault, index }, () => text);
    }
    catch {
        if (out.json)
            print(out, "context", { context: "" }, null, () => "");
    }
    finally {
        ctxStore?.close();
    }
    return 0;
};
