// `brain setup`.
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { readUserConfig, slug } from "../config.js";
import { applySetup, detectHarnesses, findVaultCandidates, interactiveSetup, recommendSync, type SetupChoices } from "../setup.js";
import { type Harness } from "../agent.js";
import { CliError, type Ctx, type Handler } from "./shared.js";

export const setupHandler: Handler = (_args, flags, ctx) => setupCommand(flags, ctx);

export async function setupCommand(flags: Record<string, unknown>, ctx: Ctx): Promise<number> {
  const { out, print } = ctx;
  const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true && !flags.yes && !out.json;
  let choices: SetupChoices | null;
  if (interactive) {
    choices = await interactiveSetup();
    if (!choices) {
      process.stderr.write("Nothing was written.\n");
      return 0;
    }
  } else {
    if (!flags.yes) {
      throw new CliError("usage", "setup asks questions in a terminal; elsewhere pass --yes with the choices as flags (brain help)", 2);
    }
    const vaultFlag = flags.vault as string | undefined;
    const vault = vaultFlag ? resolve(vaultFlag) : findVaultCandidates()[0];
    if (!vault || !existsSync(vault)) throw new CliError("no_vault", "no vault given or found: pass --vault <dir>", 1);
    const sync = (flags.sync as string | undefined) ?? recommendSync(vault).mode;
    if (!["auto", "git", "none"].includes(sync)) throw new CliError("usage", "--sync must be auto, git or none", 2);
    const agents = flags.agents === undefined ? detectHarnesses() : String(flags.agents).split(",").map((a) => a.trim()).filter(Boolean);
    for (const a of agents) if (!["claude", "pi", "agents"].includes(a)) throw new CliError("usage", `unknown agent harness '${a}'`, 2);
    const t = flags.telemetry as string | undefined;
    if (t !== undefined && !["yes", "no"].includes(t)) throw new CliError("usage", "--telemetry must be yes or no", 2);
    const u = flags["update-check"] as string | undefined;
    if (u !== undefined && !["yes", "no"].includes(u)) throw new CliError("usage", "--update-check must be yes or no", 2);
    const machine = slug((flags.machine as string | undefined) ?? String(readUserConfig().machine ?? "")) || slug(hostname().replace(/\.local$/i, ""));
    choices = {
      vault,
      machine,
      sync: sync as SetupChoices["sync"],
      agents: agents as Harness[],
      telemetry: t === undefined ? null : t === "yes",
      updateCheck: u === undefined ? null : u === "yes",
      profile: flags.profile === true,
    };
  }
  const result = applySetup(choices);
  const conflicts = result.installs.flatMap((r) => r.files.filter((f) => f.status === "conflict").map((f) => f.path));
  print(out, "setup", { ...result, conflicts }, null, () =>
    [
      `\nWrote ${result.configPath}`,
      ...result.installs.flatMap((r) => [`${r.harness}:`, ...r.files.map((f) => `  ${f.status}  ${f.path}`), ...r.warnings.map((w) => `  warning: ${w}`), ...r.next.flatMap((n) => n.split("\n")).map((n) => `  ${n}`)]),
      ...(conflicts.length ? [`Not replaced (not written by brain; rerun brain agent install <harness> --force): ${conflicts.join(", ")}`] : []),
      result.profile ? (result.profile.added ? `Added to ${result.profile.file}: ${result.profile.line}` : `${result.profile.file} already sets BRAIN_VAULT`) : "",
      "",
      "Next: brain doctor (checks this machine) · brain search \"something you know is in there\"",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  );
  return 0;
}
