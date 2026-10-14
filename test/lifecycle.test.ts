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

// Configure learnings.md as this machine's learning export and write it once.
function exportLearnings(): string {
  const target = join(vault, "..", "learnings.md");
  writeFileSync(join(vault, "..", "none.json"), JSON.stringify({ exports: [{ kind: "learning", path: target }] }));
  assert.equal(brain(["export"]).code, 0);
  return target;
}

test("import does not claim an absent active entry was removed", () => {
  brain(["log", "add", "learning", "Never exported"]);
  const imported = join(vault, "learnings.md");
  writeFileSync(imported, "- Curated entry\n");

  const result = brainText(["log", "import", "learning", imported]);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /retire|replace|Never exported/);
});

test("import offers a body-only rewording of an exported entry for replacement, and replace takes --body", () => {
  const old = brain(["log", "add", "learning", "Deploy safely", "--body", "old detail", "--tag", "ops"]);
  const oldPath = old.body.data.path as string;
  const original = readFileSync(join(vault, oldPath), "utf8");
  const target = exportLearnings();
  writeFileSync(target, readFileSync(target, "utf8").replace("old detail", "new detail\n  second line"));

  const result = brain(["log", "import", "learning", target]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.body.data.added, []);
  assert.deepEqual(result.body.data.retirementCandidates, []);
  assert.deepEqual(result.body.data.replacementCandidates, [
    { path: oldPath, title: "Deploy safely", body: "old detail", replacement: { title: "Deploy safely", body: "new detail\nsecond line" } },
  ]);
  assert.match(brainText(["log", "import", "learning", target]).stdout, /new body there[\s\S]*"new detail\\nsecond line"/);
  assert.equal(brain(["export"]).code, 5, "export keeps refusing while the rewording is pending");

  const replaced = brain(["log", "replace", oldPath, "--text", "Deploy safely", "--body", "new detail\nsecond line"]);
  assert.equal(replaced.code, 0);
  assert.equal(readFileSync(join(vault, oldPath), "utf8"), original, "replace never edits the old entry");
  const after = brain(["log", "import", "learning", target]);
  assert.deepEqual([after.body.data.added, after.body.data.skipped], [[], 1]);
  assert.deepEqual([after.body.data.retirementCandidates, after.body.data.replacementCandidates], [[], []]);
  assert.equal(brain(["export"]).code, 0);
  const view = brain(["view", "learning"]).body.data.markdown as string;
  assert.match(view, /- Deploy safely\n {2}new detail\n {2}second line\n$/);
  assert.doesNotMatch(view, /old detail/);
  const active = brain(["log", "10", "--kind", "learning"]).body.data.entries;
  assert.deepEqual(active.map((entry: { tags: string[] }) => entry.tags), [["ops"]]);
});

test("import of case-only corrections: a changed body is a replacement, a changed title a retirement", () => {
  const oldBody = brain(["log", "add", "learning", "Body case", "--body", "run npm"]);
  const oldTitle = brain(["log", "add", "learning", "title case", "--body", "same detail"]);
  brain(["log", "add", "learning", "No change", "--body", "stable detail"]);
  const target = exportLearnings();
  writeFileSync(target, ["- Body case", "  Run npm", "- Title Case", "  same detail", "- No change", "  stable detail", ""].join("\n"));

  const result = brain(["log", "import", "learning", target]);
  assert.equal(result.code, 0);
  assert.equal(result.body.data.added.length, 1);
  assert.equal(result.body.data.skipped, 1);
  assert.deepEqual(result.body.data.retirementCandidates.map((c: { path: string }) => c.path), [oldTitle.body.data.path]);
  assert.deepEqual(result.body.data.replacementCandidates.map((c: { path: string }) => c.path), [oldBody.body.data.path]);

  assert.equal(brain(["log", "retire", oldTitle.body.data.path]).code, 0);
  assert.equal(brain(["log", "replace", oldBody.body.data.path, "--text", "Body case", "--body", "Run npm"]).code, 0);
  const view = brain(["view", "learning"]).body.data.markdown;
  assert.match(view, /- Body case\n {2}Run npm/);
  assert.match(view, /- Title Case\n {2}same detail/);
  assert.doesNotMatch(view, /run npm|title case/);
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

test("retire and replace need both the entry's kind and the lifecycle write kind", () => {
  write("brain.json", JSON.stringify({
    integrations: {
      "kind-only": { read: [], write: ["interview"] },
      "lifecycle-only": { read: ["log/"], write: ["lifecycle"] },
      both: { read: [], write: ["interview", "lifecycle"] },
    },
  }));
  const entry = brain(["log", "add", "interview", "Screen notes"]).body.data.path as string;
  for (const as of ["kind-only", "lifecycle-only"]) {
    const retire = brain(["log", "retire", entry], { BRAIN_AS: as });
    assert.equal(retire.code, 6, `${as} cannot retire`);
    assert.equal(retire.body.error.code, "not_permitted");
    assert.equal(brain(["log", "replace", entry, "--text", "New notes"], { BRAIN_AS: as }).code, 6, `${as} cannot replace`);
  }
  assert.equal(readdirSync(join(vault, "log")).includes("lifecycle"), false, "a denied command writes nothing");
  assert.deepEqual(brain(["log", "10"]).body.data.entries.map((e: { title: string }) => e.title), ["Screen notes"]);
  assert.equal(brain(["log", "replace", entry, "--text", "New notes"], { BRAIN_AS: "both" }).code, 0);
});
