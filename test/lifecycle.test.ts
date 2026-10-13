import "./isolate.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/brain.js");
let vault: string;

function brain(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, ...args, "--json"], {
    cwd: vault,
    env: { ...process.env, BRAIN_VAULT: vault, BRAIN_CONFIG: join(vault, "..", "none.json"), BRAIN_MACHINE: "mini", BRAIN_AS: "", BRAIN_TODAY: "2026-10-13", ...env },
    encoding: "utf8",
  });
  return { code: r.status, body: JSON.parse(r.stdout) };
}
function write(rel: string, content: string) {
  mkdirSync(dirname(join(vault, rel)), { recursive: true });
  writeFileSync(join(vault, rel), content);
}

beforeEach(() => {
  vault = join(mkdtempSync(join(tmpdir(), "brain-life-")), "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  write("Finance/robinhood.md", "# Robinhood\nBalance snapshot.\n");
  write("Finance/kent.md", "---\ncategory: current-state\nas-of: 2026-09-01\n---\n# Kent rental\nManager fee.\n");
  write("Principles.md", "---\ncategory: principle\n---\n# Principles\nBe direct.\n");
});
afterEach(() => rmSync(dirname(vault), { recursive: true, force: true }));

test("frontmatter lifecycle: a current-state note past 30 days is overdue and flagged in search and get", () => {
  const status = brain(["lifecycle", "status", "--due"]);
  assert.deepEqual(status.body.data.notes.map((n: { path: string }) => n.path), ["Finance/kent.md"]);
  assert.equal(status.body.data.notes[0].due, "2026-10-01");

  const hit = brain(["search", "manager fee"]).body.data.results[0];
  assert.equal(hit.path, "Finance/kent.md");
  assert.equal(hit.lifecycle.overdue, true);
  assert.equal(brain(["get", "Finance/kent"]).body.data.lifecycle.overdue, true);
  assert.equal(brain(["get", "Principles"]).body.data.lifecycle.due, null, "enduring categories are never due");
});

test("set requires --as-of for time-bound categories; review clears overdue; all as new log files", () => {
  assert.equal(brain(["lifecycle", "set", "Finance/robinhood", "--category", "current-state"]).code, 2);
  const set = brain(["lifecycle", "set", "Finance/robinhood", "--category", "current-state", "--as-of", "2026-07-24"]);
  assert.equal(set.code, 0);
  assert.equal(set.body.data.state.overdue, true);
  assert.equal(readFileSync(join(vault, "Finance/robinhood.md"), "utf8"), "# Robinhood\nBalance snapshot.\n", "the note is never edited");

  const review = brain(["lifecycle", "review", "Finance/robinhood", "--on", "2026-10-12"]);
  assert.equal(review.body.data.state.overdue, false);
  assert.equal(review.body.data.state.due, "2026-11-11");
  assert.equal(readdirSync(join(vault, "log/lifecycle")).length, 2);
  assert.equal(brain(["lifecycle", "set", "Principles", "--category", "nonsense"]).code, 2);
  assert.equal(brain(["lifecycle", "review", "Principles", "--on", "13/10/2026"]).code, 2);
});

test("archive hides a note from search (and lifecycle events never appear in search); restore brings it back", () => {
  assert.equal(brain(["lifecycle", "archive", "Finance/kent"]).code, 2, "archive needs --reason");
  assert.equal(brain(["lifecycle", "archive", "Finance/kent", "--reason", "Property sold"]).code, 0);
  assert.equal(brain(["search", "kent"]).body.data.results.length, 0);
  const all = brain(["search", "kent", "--include-archived"]).body.data.results;
  assert.deepEqual(all.map((h: { path: string }) => h.path), ["Finance/kent.md"]);
  assert.equal(all[0].lifecycle.archived, true);
  assert.equal(brain(["lifecycle", "status", "--due"]).body.data.notes.length, 0, "archived notes are never overdue");
  brain(["lifecycle", "restore", "Finance/kent"]);
  assert.equal(brain(["search", "kent"]).body.data.results.length, 1);
});

test("custom review windows from brain.json; the primer warns about overdue notes", () => {
  write("brain.json", JSON.stringify({ lifecycle: { windows: { "current-state": 60 } } }));
  assert.equal(brain(["get", "Finance/kent"]).body.data.lifecycle.overdue, false);
  rmSync(join(vault, "brain.json"));
  assert.match(brain(["context"]).body.data.context, /1 note\(s\) are past their review date/);
});

test("an integration needs the lifecycle write kind to record changes", () => {
  write("brain.json", JSON.stringify({ integrations: { coach: { read: ["Finance/"], write: ["interview"] } } }));
  const r = brain(["lifecycle", "review", "Finance/kent"], { BRAIN_AS: "coach" });
  assert.equal(r.code, 6);
});
