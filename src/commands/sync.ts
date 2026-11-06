// `brain sync`.
import { sync } from "../sync.js";
import { runExports, formatExports, driftMessage } from "./log.js";
import { type Handler } from "./shared.js";

export const syncCommand: Handler = (args, flags, ctx) => {
  const { out, print } = ctx;
  const { vault, cfg, store } = ctx.vault!;
  let index = ctx.vault!.index;
  const command = "sync";
  const result = sync(vault, cfg, { push: !flags["no-push"] });
  index = store.refresh();
  const exports = runExports(store, cfg, false);
  print(out, command, { ...result, machine: cfg.machine, exports }, { vault, index }, () =>
    [
      result.mode === "none"
        ? `${cfg.machine}: sync mode "none" — files are moved by your sync service; index refreshed`
        : result.mode === "command"
          ? `${cfg.machine}: ran the configured sync command`
          : `${cfg.machine}: committed ${result.committed} · pulled ${result.pulled} · ` +
            (result.remote ? (result.pushed ? "pushed" : "nothing to push") : "no upstream — local commit only"),
      formatExports(exports),
    ]
      .filter(Boolean)
      .join("\n"),
  );
  // The sync itself succeeded; unrecorded edits to an export are surfaced
  // in data.exports and on stderr rather than failing the whole sync.
  const drift = exports.filter((e) => e.status === "drift");
  if (drift.length && !out.json) process.stderr.write(`brain: ${driftMessage(drift)}\n`);
  return 0;
};
