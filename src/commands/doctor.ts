// `brain doctor`.
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { userSettings, type Config } from "../config.js";
import * as update from "../update.js";
import { type RefreshStats } from "../store.js";
import { brainPaths } from "../paths.js";
import { isGitRepo, resolveSyncMode } from "../sync.js";
import { type Handler } from "./shared.js";

export const doctorCommand: Handler = (args, flags, ctx) => {
  const { out, print } = ctx;
  const { vault, cfg, store, index } = ctx.vault!;
  const command = "doctor";
  const checks = doctor(vault, cfg, index, store.count(), ctx.version);
  print(out, command, { checks }, { vault, index }, () =>
    checks.map((c) => `${c.status === "ok" ? "ok  " : "WARN"}  ${c.check}: ${c.detail}`).join("\n"),
  );
  return 0;
};

export interface Check {
  check: string;
  status: "ok" | "warn";
  detail: string;
}

// Each check names what it found and, when it warns, what to do. Nothing here
// changes anything: doctor only reads.
export function doctor(vault: string, cfg: Config, index: RefreshStats, notes: number, version: string): Check[] {
  const checks: Check[] = [];
  const state = brainPaths(vault, cfg.logDir).state;
  const synced = /\/Library\/Mobile Documents\/|\/Library\/CloudStorage\/|\/Dropbox\/|\/OneDrive\//.test(vault + "/");
  const mode = resolveSyncMode(vault, cfg);
  checks.push({ check: "vault", status: "ok", detail: `${vault} (${notes} notes)` });
  checks.push({
    check: "index",
    status: state.startsWith(vault + "/") ? "warn" : "ok",
    detail: `${state}${state.startsWith(vault + "/") ? " is inside the vault; set BRAIN_STATE_DIR outside it" : " (outside the vault, never synced)"}`,
  });
  const up = update.status(version, userSettings().updateCheck);
  checks.push({
    check: "update",
    status: up.available ? "warn" : "ok",
    detail: up.available
      ? `brain ${up.latest} is available (you have ${up.current}): ${up.command}`
      : !up.enabled
        ? `${up.current}; daily check off (${up.reason})`
        : up.latest
          ? `${up.current} is the latest release`
          : `${up.current}; no release checked yet (brain update --check)`,
  });
  checks.push({
    check: "sync",
    status: "ok",
    detail: typeof cfg.sync === "object" ? `command: ${cfg.sync.command}` : `${cfg.sync}${cfg.sync === "auto" ? ` → ${mode}` : ""}${synced ? " (vault is in a cloud-synced folder)" : ""}`,
  });
  if (synced && isGitRepo(vault)) {
    checks.push({
      check: "git in a synced folder",
      status: "warn",
      detail:
        "the vault is a git repository inside iCloud/Dropbox/OneDrive. Two sync systems on one folder can corrupt .git. " +
        "Keep git out of the synced copy (a separate clone, or .git moved to .git.nosync with a .git symlink for iCloud), " +
        'or pick one: "sync": "none" if the cloud folder is the sync.',
    });
  }
  if (index.offline) {
    checks.push({
      check: "offline notes",
      status: "warn",
      detail: `${index.offline} note(s) are cloud placeholders on this machine; search uses what was last indexed, get cannot read them. ` +
        'Turn off "Optimize Mac Storage" for the vault folder, or keep it downloaded.',
    });
  }
  for (const v of cfg.exports) {
    checks.push({ check: `view ${v.kind}`, status: existsSync(dirname(v.path)) ? "ok" : "warn", detail: existsSync(dirname(v.path)) ? v.path : `${dirname(v.path)} does not exist on this machine` });
  }
  if (cfg.as) checks.push({ check: "acting as", status: "ok", detail: cfg.as.name });
  return checks;
}
