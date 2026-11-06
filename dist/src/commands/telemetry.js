// `brain telemetry`.
import { userSettings } from "../config.js";
import * as telemetry from "../telemetry.js";
import { CliError } from "./shared.js";
export const telemetryCommand = async (args, flags, ctx) => {
    const { out, print } = ctx;
    const [sub = "status"] = args;
    const settings = userSettings();
    if (sub === "flush") {
        const r = await telemetry.flush();
        print(out, "telemetry.flush", r, null, () => (r.error ? `not sent: ${r.error}` : `sent ${r.sent} event(s)`));
        return 0;
    }
    if (sub === "enable" || sub === "disable")
        telemetry.setEnabled(sub === "enable");
    if (sub === "reset")
        telemetry.resetInstallId();
    if (!["status", "show", "enable", "disable", "reset"].includes(sub)) {
        throw new CliError("usage", "usage: brain telemetry [status|show|enable|disable|reset]", 2);
    }
    const st = telemetry.status(settings.telemetry);
    if (sub === "show") {
        const events = telemetry.queue();
        print(out, "telemetry.show", { ...st, events }, null, () => events.length ? events.map((e) => JSON.stringify(e)).join("\n") : "no events queued");
        return 0;
    }
    print(out, `telemetry.${sub}`, st, null, () => [
        `telemetry: ${st.enabled ? "on" : "off"} (${st.reason})`,
        `collector: ${st.collector ?? "not configured — events stay on this machine"}`,
        `queued: ${st.queued} event(s) · install id: ${st.install}`,
        "what is collected: docs/telemetry.md · see it: brain telemetry show · stop: brain telemetry disable",
    ].join("\n"));
    return 0;
};
