// `brain update`.
import { userSettings } from "../config.js";
import * as update from "../update.js";
import { CliError } from "./shared.js";
export const updateCommand = async (args, flags, ctx) => {
    const { out, print, version: VERSION } = ctx;
    const command = "update";
    if (args.length)
        throw new CliError("usage", "usage: brain update [--check]", 2);
    const configCheck = userSettings().updateCheck;
    let error = null;
    if (flags.check)
        error = (await update.check(VERSION)).error;
    const st = update.status(VERSION, configCheck);
    print(out, command, { ...st, error }, null, () => [
        st.available
            ? `brain ${st.latest} is available (you have ${st.current}). Update with:\n  ${st.command}`
            : st.latest
                ? `brain ${st.current} is the latest release.`
                : `brain ${st.current}. No release has been checked yet${flags.check ? "" : ": run brain update --check"}.`,
        ...(error ? [`check failed: ${error}`] : []),
        st.checkedAt ? `last checked ${st.checkedAt.slice(0, 10)}` : "",
        st.enabled ? "" : `daily check off (${st.reason})`,
    ]
        .filter(Boolean)
        .join("\n"));
    return 0;
};
