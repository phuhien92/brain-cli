// `brain agent`.
import { HARNESSES, install } from "../agent.js";
import { CliError } from "./shared.js";
export const agentCommand = (args, flags, ctx) => {
    const { out, print } = ctx;
    const [sub, harness = ""] = args;
    if (sub !== "install" || !HARNESSES.includes(harness)) {
        throw new CliError("usage", `usage: brain agent install <${HARNESSES.join("|")}> [--dry-run] [--force]`, 2);
    }
    const result = install(harness, { force: flags.force, dryRun: flags["dry-run"] });
    const conflicts = result.files.filter((f) => f.status === "conflict");
    if (conflicts.length) {
        throw new CliError("install_conflict", `${conflicts.map((f) => f.path).join(", ")} exists and was not written by brain; rerun with --force to replace it`, 5, { files: conflicts.map((f) => f.path) });
    }
    print(out, "agent.install", { ...result, dryRun: flags["dry-run"] }, null, () => [
        ...result.files.map((f) => `${flags["dry-run"] && f.status === "written" ? "would write" : f.status}  ${f.path}`),
        ...result.warnings.map((w) => `warning: ${w}`),
        ...(result.next.length ? ["", ...result.next] : []),
    ].join("\n"));
    return 0;
};
