// `brain feedback`.
import { userSettings } from "../config.js";
import { createDraft, diagnostics, getDraft, issueUrl, KINDS, lastError, listDrafts, markSubmitted, postWithGh, redactor, repo, type Kind } from "../feedback.js";
import { Store } from "../store.js";
import { CliError, type Ctx, type Handler } from "./shared.js";

export const feedbackHandler: Handler = (args, flags, ctx) => feedbackCommand(args, flags, ctx);

export async function feedbackCommand(
  args: string[],
  flags: Record<string, unknown>,
  ctx: Ctx,
): Promise<number> {
  const { out, print, findVault, version: VERSION } = ctx;
  const [sub, ...rest] = args;

  if (sub === "list") {
    const drafts = listDrafts();
    print(out, "feedback.list", { drafts }, null, () =>
      drafts.length
        ? drafts.map((d) => `${d.id}  ${d.status.padEnd(9)} ${d.kind.padEnd(4)} ${d.title}`).join("\n")
        : "no feedback drafts",
    );
    return 0;
  }

  if (sub === "show" || sub === "submit") {
    const id = rest[0] ?? "";
    const draft = getDraft(id);
    if (!draft) throw new CliError("not_found", `no feedback draft '${id}' (brain feedback list)`, 3);
    if (sub === "show") {
      print(out, "feedback.show", { ...draft, url: draft.url ?? issueUrl(draft) }, null, () =>
        `${draft.title}\n\n${draft.body}\n\n${Object.entries(draft.diagnostics).map(([k, v]) => `${k}: ${v}`).join("\n")}`,
      );
      return 0;
    }
    if (!flags.post) {
      // The default: a person opens the page, reads it, and submits it.
      const url = issueUrl(draft);
      print(out, "feedback.submit", { id: draft.id, posted: false, url }, null, () =>
        `Open this link, review the report, and click "Submit new issue":\n${url}`,
      );
      return 0;
    }
    // Posting without a person in the loop needs their say-so: either they
    // allowed it on this machine, or they asked for this report to be posted.
    const allowed = userSettings().feedbackPost === "allow";
    if (!allowed && !flags["user-approved"]) {
      throw new CliError(
        "not_permitted",
        'posting needs the user\'s permission: they asked for it (--user-approved) or allowed it ("feedback": { "post": "allow" } in ~/.config/brain/config.json)',
        6,
      );
    }
    let posted: string;
    try {
      posted = postWithGh(draft);
    } catch (err) {
      throw new CliError("post_failed", `gh issue create failed (${(err as Error).message.split("\n")[0]}); submit by link instead: brain feedback submit ${draft.id}`, 1);
    }
    const done = markSubmitted(draft, posted);
    print(out, "feedback.submit", { id: done.id, posted: true, url: posted }, null, () => posted);
    return 0;
  }

  // Create a draft: brain feedback "<what happened>" [--kind] [--title] [--from-last-error]
  const text = (sub === "add" ? rest : args).join(" ").trim();
  const last = flags["from-last-error"] ? lastError() : null;
  if (flags["from-last-error"] && !last) throw new CliError("not_found", "no recorded error on this machine", 3);
  if (!text && !last) {
    throw new CliError("usage", 'usage: brain feedback "<what happened>" [--kind bug|idea|docs] [--title …] [--from-last-error]', 2);
  }
  const kind = (flags.kind as string | undefined) ?? "bug";
  if (!(KINDS as readonly string[]).includes(kind)) throw new CliError("usage", `--kind must be one of: ${KINDS.join(", ")}`, 2);

  // Redact against this vault when there is one: its path and every note's
  // path and title become placeholders.
  let vault: string | null = null;
  let notes: { path: string; title: string }[] = [];
  let s: Store | null = null;
  try {
    vault = findVault(flags.vault as string | undefined);
    s = Store.open(vault);
    s.refresh();
    notes = s.db.prepare("SELECT path, title FROM notes").all() as { path: string; title: string }[];
  } catch {
    vault = null;
  } finally {
    s?.close();
  }
  const redact = redactor({ vault, notes });
  const body = [
    text || "(no description)",
    ...(last
      ? ["", "### What failed", "", "```", `brain ${last.args.join(" ")}`, `exit ${last.exit} · ${last.code}`, last.message, "```"]
      : []),
  ].join("\n");
  const title = (flags.title as string | undefined)?.trim() || (last ? `${last.command}: ${last.code}` : text.split("\n")[0]!.slice(0, 80));
  const draft = createDraft(
    {
      kind: kind as Kind,
      title,
      body,
      diagnostics: diagnostics(VERSION, last ? { command: last.command, error: last.code, exit: String(last.exit) } : {}),
      fingerprintSeed: last ? `${last.command}|${last.code}|${VERSION}` : `${kind}|${title.toLowerCase()}`,
    },
    redact,
  );
  print(out, "feedback.add", { draft, repo: repo() }, null, () =>
    [
      `drafted ${draft.id} (${draft.kind}) — redacted preview:`,
      "",
      `  ${draft.title}`,
      ...draft.body.split("\n").map((l) => `  ${l}`),
      "",
      `review: brain feedback show ${draft.id}`,
      `submit: brain feedback submit ${draft.id}   (prints a link for a person to submit)`,
    ].join("\n"),
  );
  return 0;
}
