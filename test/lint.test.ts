import "./isolate.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const evidence = "immutable evidence\n";
  const evidenceHash = createHash("sha256").update(evidence).digest("hex");
  write("sources/evidence.pdf", evidence);
  write("sources/evidence.pdf.source.md", `---\ntitle: Evidence\ningested: 2026-10-13T00:00:00.000Z\nmachine: mini\norigin: /tmp/evidence.pdf\nsha256: ${evidenceHash}\ntags: []\n---\n`);
  write("Claims/frontmatter.md", "---\nsources: [[sources/evidence.pdf]]\n---\n# Cited in frontmatter\n");
  write("Claims/wiki.md", "# Cited with a link\n[[sources/evidence.pdf]]\n");
  write("Claims/missing.md", "---\nsources: [[sources/gone.pdf]]\n---\n# Missing source\n");
  write("Claims/none.md", "# No citation\n");
  write("Other/no-source-needed.md", "# No citation needed\n");
  write("brain.json", JSON.stringify({ lint: { maxLines: { "MEMORY.md": 5 }, unsourced: ["Claims/"] } }));
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
  assert.deepEqual(by("source-missing"), ["Claims/missing.md: source [[sources/gone.pdf]] does not resolve to any note or file"]);
  assert.deepEqual(by("unsourced"), ["Claims/none.md: no source citation"]);
  assert.deepEqual(by("source-modified"), []);
  const orphans = by("orphan").map((x) => x.split(":")[0]);
  assert.ok(orphans.includes("Career/lonely.md"));
  assert.ok(!orphans.includes("Career/plan.md"), "linked notes are not orphans");
  assert.ok(!orphans.includes("MEMORY.md"), "root notes are entry points");
  assert.equal(f[0]!.severity, "warn", "warnings sort before info");
});

test("lint reports an immutable source whose bytes changed", () => {
  write("sources/evidence.pdf", "edited evidence\n");
  const findings = brain(["lint"]).body.data.findings as { rule: string; path: string }[];
  assert.deepEqual(findings.filter((f) => f.rule === "source-modified").map((f) => f.path), ["sources/evidence.pdf"]);
  write("sources/evidence.pdf", "immutable evidence\n");
});

test("lint --strict exits 7 when there are warnings", () => {
  const r = brain(["lint", "--strict"]);
  assert.equal(r.code, 7);
  assert.equal(r.body.error.code, "lint_failed");
  assert.ok(r.body.error.counts.warn > 0);
});
