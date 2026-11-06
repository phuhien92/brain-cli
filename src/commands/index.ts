// `brain index`.
import { type Handler } from "./shared.js";

export const indexCommand: Handler = (args, flags, ctx) => {
  const { out, print } = ctx;
  const { vault, store, index } = ctx.vault!;
  const command = "index";
  const data = { notes: store.count(), ...index };
  print(out, command, data, { vault, index }, () =>
    `${vault}\n${data.notes} notes · +${index.added} ~${index.updated} -${index.removed} · ${index.ms}ms`,
  );
  return 0;
};
