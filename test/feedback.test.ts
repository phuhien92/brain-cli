import "./isolate.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { redactor } from "../src/feedback.js";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/brain.js");
let root: string;
let vault: string;

function brain(args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, ...args, "--json"], {
    cwd: vault,
    env: { ...process.env, BRAIN_VAULT: vault, BRAIN_CONFIG: join(root, "config.json"), BRAIN_MACHINE: "mini", BRAIN_AS: "", DO_NOT_TRACK: "1", ...extra },
    encoding: "utf8",
  });
  return { code: r.status, body: JSON.parse(r.stdout) };
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "brain-fb-"));
  vault = join(root, "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  mkdirSync(join(vault, "Finance"));
  writeFileSync(join(vault, "Finance/severance.md"), "# Severance package\n");
});
after(() => rmSync(root, { recursive: true, force: true }));

test("redactor: note paths and titles, vault, home, emails, amounts, long numbers", () => {
  const r = redactor({ vault: "/v/My Vault", notes: [{ path: "Finance/severance.md", title: "Severance package" }] });
  const out = r(
    `In /v/My Vault/Finance/severance.md ("Severance package") at ${homedir()}/x, ` +
      "mail me@example.com about $50,892.58 on account 679478370 #5QX46967",
  );
  assert.equal(out, 'In <vault>/<note-1> ("<note-1-title>") at ~/x, mail <email> about <amount> on account <number> #<id>');
});

test("a draft from the last error is redacted and never names the note", () => {
  assert.equal(brain(["get", "Finance/severance-plan"]).code, 3);
  const r = brain(["feedback", "get could not find my plan", "--from-last-error"]);
  assert.equal(r.code, 0);
  const d = r.body.data.draft;
  const all = JSON.stringify(d);
  assert.ok(!all.includes("Finance/severance"), all);
  assert.ok(!all.includes(vault));
  assert.match(d.body, /exit 3 · not_found/);
  assert.equal(d.diagnostics.error, "not_found");
  assert.equal(d.status, "draft");
});

test("submit prints a link for a person by default; posting needs the user's permission", () => {
  const id = brain(["feedback", "search should accept --since", "--kind", "idea"]).body.data.draft.id;
  const link = brain(["feedback", "submit", id]).body.data;
  assert.equal(link.posted, false);
  assert.match(link.url, /^https:\/\/github\.com\/phuhien92\/brain-cli\/issues\/new\?title=%5Bidea%5D/);

  const denied = brain(["feedback", "submit", id, "--post"]);
  assert.equal(denied.code, 6);
  assert.equal(denied.body.error.code, "not_permitted");

  // A stand-in gh records the call and prints an issue URL.
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "$@" > "$(dirname "$0")/gh-args"\necho https://github.com/phuhien92/brain-cli/issues/99\n');
  chmodSync(join(bin, "gh"), 0o755);
  const PATH = `${bin}:${process.env.PATH}`;
  const posted = brain(["feedback", "submit", id, "--post", "--user-approved"], { PATH });
  assert.equal(posted.code, 0);
  assert.equal(posted.body.data.url, "https://github.com/phuhien92/brain-cli/issues/99");
  assert.equal(brain(["feedback", "show", id]).body.data.status, "submitted");

  writeFileSync(join(root, "config.json"), JSON.stringify({ feedback: { post: "allow" } }));
  const id2 = brain(["feedback", "docs: lifecycle example is wrong", "--kind", "docs"]).body.data.draft.id;
  assert.equal(brain(["feedback", "submit", id2, "--post"], { PATH }).code, 0, "allowed in config");
  rmSync(join(root, "config.json"));
});
