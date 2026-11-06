// `brain lint`.
import { lint } from "../lint.js";
import { formatFindings } from "./format.js";
import { CliError, type Handler } from "./shared.js";

export const lintCommand: Handler = (args, flags, ctx) => {
  const { out, print } = ctx;
  const { vault, cfg, store, index } = ctx.vault!;
  const command = "lint";
  const findings = lint(store, cfg);
  const counts = { warn: findings.filter((f) => f.severity === "warn").length, info: findings.filter((f) => f.severity === "info").length };
  if (flags.strict && counts.warn) {
    if (!out.json && !out.quiet) process.stdout.write(formatFindings(findings) + "\n");
    throw new CliError("lint_failed", `${counts.warn} warning(s)`, 7, { findings, counts });
  }
  print(out, command, { findings, counts }, { vault, index }, () => (findings.length ? formatFindings(findings) : "no findings"));
  return 0;
};
