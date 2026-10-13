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
function brainText(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, ...args], {
    cwd: vault,
    env: { ...process.env, BRAIN_VAULT: vault, BRAIN_CONFIG: join(vault, "..", "none.json"), BRAIN_MACHINE: "mini", BRAIN_AS: "", BRAIN_TODAY: "2026-10-13", ...env },
    encoding: "utf8",
  });
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
  const reason = 'Property sold to "Buyer"';
  assert.equal(brain(["lifecycle", "archive", "Finance/kent", "--reason", reason]).code, 0);
  assert.equal(brain(["search", "kent"]).body.data.results.length, 0);
  const all = brain(["search", "kent", "--include-archived"]).body.data.results;
  assert.deepEqual(all.map((h: { path: string }) => h.path), ["Finance/kent.md"]);
  assert.equal(all[0].lifecycle.archived, true);
  assert.equal(all[0].lifecycle.reason, reason);
  assert.equal(brain(["lifecycle", "status", "--due"]).body.data.notes.length, 0, "archived notes are never overdue");
  brain(["lifecycle", "restore", "Finance/kent"]);
  assert.equal(brain(["search", "kent"]).body.data.results.length, 1);
});

test("log retire and replace append lifecycle events while views omit retired entries", () => {
  const retired = brain(["log", "add", "learning", "Old wording", "--body", "Keep this detail", "--tag", "ops"]);
  const retiredPath = retired.body.data.path as string;
  const original = readFileSync(join(vault, retiredPath), "utf8");
  const reason = 'superseded by "v2" at C:\\temp';

  const retirement = brain(["log", "retire", retiredPath, "--reason", reason]);
  assert.equal(retirement.code, 0);
  assert.equal(retirement.body.data.target, retiredPath);
  assert.equal(readFileSync(join(vault, retiredPath), "utf8"), original, "retiring never edits the entry");
  const event = readFileSync(join(vault, retirement.body.data.event), "utf8");
  assert.match(event, /action: "retire"/);
  assert.equal(brain(["get", retirement.body.data.event, "--meta"]).body.data.frontmatter.reason, reason);
  assert.equal(brain(["view", "learning"]).body.data.entries, 0);
  assert.ok(
    brain(["lifecycle", "status"]).body.data.notes.every((note: { path: string }) => note.path !== retiredPath),
    "retirements do not become note lifecycle states",
  );

  const old = brain(["log", "add", "learning", "Needs rewording", "--body", "Preserved body", "--tag", "ops"]);
  const oldPath = old.body.data.path as string;
  const replaced = brain(["log", "replace", oldPath, "--text", "Clear wording\nCorrected body"]);
  assert.equal(replaced.code, 0);
  assert.equal(replaced.body.data.target, oldPath);
  assert.match(replaced.body.data.replacement, /^log\/learning\//);
  assert.equal(readFileSync(join(vault, oldPath), "utf8").includes("Needs rewording"), true);
  const view = brain(["view", "learning"]).body.data.markdown as string;
  assert.doesNotMatch(view, /Old wording|Needs rewording/);
  assert.match(view, /- Clear wording\n {2}Corrected body/);
  assert.doesNotMatch(view, /Preserved body/);
  const active = brain(["log", "10", "--kind", "learning"]).body.data.entries;
  assert.deepEqual(active.map((entry: { title: string }) => entry.title), ["Clear wording"]);
  assert.equal(readdirSync(join(vault, "log/lifecycle")).length, 2);
});

test("replace completes with quoted log paths", () => {
  write("brain.json", JSON.stringify({ log: { dir: 'memory/"quoted"' } }));
  const original = brain(["log", "add", "learning", "Original wording", "--body", "Stale body"]);
  const originalPath = original.body.data.path as string;
  assert.match(originalPath, /"quoted"/);

  const replaced = brain(["log", "replace", originalPath, "--text", "Replacement wording"]);
  assert.equal(replaced.code, 0);
  const active = brain(["log", "10", "--kind", "learning"]).body.data.entries;
  assert.deepEqual(active.map((entry: { title: string }) => entry.title), ["Replacement wording"]);
  assert.equal(active[0].body, "");
  const event = brain(["get", replaced.body.data.event, "--meta"]).body.data.frontmatter;
  assert.equal(event.target, originalPath);
  assert.equal(event.replacement, replaced.body.data.replacement);
});

test("import does not claim an absent active entry was removed", () => {
  brain(["log", "add", "learning", "Never exported"]);
  const imported = join(vault, "learnings.md");
  writeFileSync(imported, "- Curated entry\n");

  const result = brainText(["log", "import", "learning", imported]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /active logged entries are not present in this file/);
  assert.match(result.stdout, /path: "log\/learning\//);
  assert.doesNotMatch(result.stdout, /brain log retire|--reason|removed from imported file/);
});

test("import captures a body-only rewording and offers the old entry for retirement", () => {
  const old = brain(["log", "add", "learning", "Deploy safely", "--body", "old detail"]);
  const imported = join(vault, "learnings.md");
  writeFileSync(imported, "- Deploy safely\n  new detail\n");

  const result = brain(["log", "import", "learning", imported]);
  assert.equal(result.code, 0);
  assert.equal(result.body.data.added.length, 1);
  assert.deepEqual(result.body.data.retirementCandidates, [{ path: old.body.data.path, title: "Deploy safely", body: "old detail" }]);
  assert.match(brain(["view", "learning"]).body.data.markdown, /old detail[\s\S]*new detail/);

  assert.equal(brain(["log", "retire", old.body.data.path]).code, 0);
  const view = brain(["view", "learning"]).body.data.markdown;
  assert.doesNotMatch(view, /old detail/);
  assert.match(view, /new detail/);
});

test("import captures case-only title and body corrections", () => {
  const oldBody = brain(["log", "add", "learning", "Body case", "--body", "run npm"]);
  const oldTitle = brain(["log", "add", "learning", "title case", "--body", "same detail"]);
  brain(["log", "add", "learning", "No change", "--body", "stable detail"]);
  const imported = join(vault, "learnings.md");
  writeFileSync(imported, ["- Body case", "  Run npm", "- Title Case", "  same detail", "- No change", "  stable detail", ""].join("\n"));

  const result = brain(["log", "import", "learning", imported]);
  assert.equal(result.code, 0);
  assert.equal(result.body.data.added.length, 2);
  assert.equal(result.body.data.skipped, 1);
  assert.deepEqual(
    result.body.data.retirementCandidates.map((candidate: { path: string }) => candidate.path).sort(),
    [oldBody.body.data.path, oldTitle.body.data.path].sort(),
  );

  for (const candidate of result.body.data.retirementCandidates) {
    assert.equal(brain(["log", "retire", candidate.path]).code, 0);
  }
  const view = brain(["view", "learning"]).body.data.markdown;
  assert.match(view, /- Body case\n {2}Run npm/);
  assert.match(view, /- Title Case\n {2}same detail/);
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
