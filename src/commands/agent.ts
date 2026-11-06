// `brain agent`.
import { HARNESSES, install, type Harness } from "../agent.js";
import { CliError, type Handler } from "./shared.js";

export const agentCommand: Handler = (args, flags, ctx) => {
  const { out, print } = ctx;
  const [sub, harness = ""] = args;
  if (sub !== "install" || !(HARNESSES as readonly string[]).includes(harness)) {
    throw new CliError("usage", `usage: brain agent install <${HARNESSES.join("|")}> [--dry-run] [--force]`, 2);
  }
  const result = install(harness as Harness, { force: flags.force, dryRun: flags["dry-run"] });
  const conflicts = result.files.filter((f) => f.status === "conflict");
  if (conflicts.length) {
    throw new CliError(
      "install_conflict",
      `${conflicts.map((f) => f.path).join(", ")} exists and was not written by brain; rerun with --force to replace it`,
      5,
      { files: conflicts.map((f) => f.path) },
    );
  }
  print(out, "agent.install", { ...result, dryRun: flags["dry-run"] }, null, () =>
    [
      ...result.files.map((f) => `${flags["dry-run"] && f.status === "written" ? "would write" : f.status}  ${f.path}`),
      ...result.warnings.map((w) => `warning: ${w}`),
      ...(result.next.length ? ["", ...result.next] : []),
    ].join("\n"),
  );
  return 0;
};
