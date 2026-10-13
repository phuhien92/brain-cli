import "./isolate.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/brain.js");
let vault: string;

function brain(args: string[]) {
  const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, ...args, "--json"], {
    cwd: vault,
    env: { ...process.env, BRAIN_VAULT: vault, BRAIN_CONFIG: join(vault, "..", "none.json"), BRAIN_MACHINE: "mini", BRAIN_AS: "", BRAIN_TODAY: "2026-10-13" },
    encoding: "utf8",
  });
  return { code: r.status, body: JSON.parse(r.stdout) };
}
function write(rel: string, content: string) {
  mkdirSync(dirname(join(vault, rel)), { recursive: true });
  writeFileSync(join(vault, rel), content);
}

before(() => {
  vault = join(mkdtempSync(join(tmpdir(), "brain-lint-")), "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  write("MEMORY.md", "# Memory\n" + "- fact\n".repeat(10) + "[[Career/plan]] [[Career/Plan 2]] [[Missing note]] ![[diagram.png]] ![[gone.png]] [[Career/plan#Goals|goals]] [[boards/sketch.excalidraw]] [[chart]]\n");
  write("Career/plan.md", "# Plan\n## Goals\n");
  write("Career/Plan 2.md", "# Plan 2\nHonest title, no original 'Plan.md' beside it? There is: plan.md differs in case.\n");
  write("Career/notes 2.md", "# Notes\n");
  write("Career/notes.md", "# Notes\n[[MEMORY]]\n");
  write("Career/lonely.md", "# Lonely\n");
  write("assets/diagram.png", "png");
  write("boards/sketch.excalidraw", "{}");
  write("assets/chart.svg", "<svg/>");
  write("brain.json", JSON.stringify({ lint: { maxLines: { "MEMORY.md": 5 } } }));
  write("Finance/old.md", "---\ncategory: news\nas-of: 2026-01-01\n---\n# Old news\n");
  write("Finance/undated.md", "---\ncategory: research\n---\n# Undated\n");
});
after(() => rmSync(dirname(vault), { recursive: true, force: true }));

test("lint finds broken links, conflict copies, overdue and undated reviews, line limits, orphans", () => {
  const r = brain(["lint"]);
  assert.equal(r.code, 0);
  const f = r.body.data.findings as { rule: string; path: string; message: string; severity: string }[];
  const by = (rule: string) => f.filter((x) => x.rule === rule).map((x) => `${x.path}: ${x.message}`);

  assert.deepEqual(by("broken-link"), [
    "MEMORY.md: [[Missing note]] does not resolve to any note",
    "MEMORY.md: [[gone.png]] does not resolve to any note or file",
  ]);
  assert.deepEqual(by("conflict-copy").map((x) => x.split(":")[0]), ["Career/notes 2.md"]);
  assert.deepEqual(by("review-overdue").map((x) => x.split(":")[0]), ["Finance/old.md"]);
  assert.ok(by("lifecycle").some((x) => x.startsWith("Finance/undated.md") && /no as-of/.test(x)));
  assert.deepEqual(by("max-lines"), ["MEMORY.md: 12 lines, over this vault's limit of 5"]);
  const orphans = by("orphan").map((x) => x.split(":")[0]);
  assert.ok(orphans.includes("Career/lonely.md"));
  assert.ok(!orphans.includes("Career/plan.md"), "linked notes are not orphans");
  assert.ok(!orphans.includes("MEMORY.md"), "root notes are entry points");
  assert.equal(f[0]!.severity, "warn", "warnings sort before info");
});

test("lint --strict exits 7 when there are warnings", () => {
  const r = brain(["lint", "--strict"]);
  assert.equal(r.code, 7);
  assert.equal(r.body.error.code, "lint_failed");
  assert.ok(r.body.error.counts.warn > 0);
});
