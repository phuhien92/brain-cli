import "./isolate.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { existsSync, readdirSync } from "node:fs";
import { indexDir, Store, toMatchExpression } from "../src/store.js";

let vault: string;

function write(rel: string, content: string): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "brain-test-"));
  write("Career HQ/interview-prep.md", "---\ntags: [career]\n---\n# Interview prep\nFrontend system design rounds.\n");
  write("Finance/cobra.md", "---\naliases: [Health coverage]\n---\n# COBRA decision\nCompare premiums.\n");
  write("Reading/frontend.md", "# Reading list\nAn essay that mentions interview once.\n");
  write(".obsidian/workspace.md", "# should never be indexed\ninterview\n");
  write("node_modules/pkg/README.md", "interview\n");
});

afterEach(() => rmSync(vault, { recursive: true, force: true }));

test("first refresh indexes every note and skips dot-folders and node_modules", () => {
  const store = Store.open(vault);
  const stats = store.refresh();
  assert.equal(stats.added, 3);
  assert.equal(store.count(), 3);
  store.close();
});

test("the index lives outside the vault, so a synced vault never carries a live database", () => {
  const store = Store.open(vault);
  store.refresh();
  store.close();
  assert.ok(!existsSync(join(vault, ".brain")));
  assert.ok(!readdirSync(vault).some((f) => f.endsWith(".db")));
  const dir = indexDir(vault);
  assert.ok(dir.startsWith(process.env.BRAIN_STATE_DIR!));
  assert.ok(existsSync(join(dir, "index.db")));
  assert.equal(indexDir(vault), dir, "stable per vault");
  assert.notEqual(indexDir(vault + "-other"), dir, "distinct per vault");
});

test("refresh is incremental: unchanged, touched, edited, added, deleted", () => {
  const store = Store.open(vault);
  store.refresh();

  assert.deepEqual(pick(store.refresh()), { added: 0, updated: 0, removed: 0, unchanged: 3 });

  // Touched without an edit: hash matches, nothing re-parsed.
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(vault, "Reading/frontend.md"), later, later);
  assert.deepEqual(pick(store.refresh()), { added: 0, updated: 0, removed: 0, unchanged: 3 });

  write("Reading/frontend.md", "# Reading list\nNow about zebrafish.\n");
  write("Reading/new.md", "# New\n");
  rmSync(join(vault, "Finance/cobra.md"));
  assert.deepEqual(pick(store.refresh()), { added: 1, updated: 1, removed: 1, unchanged: 1 });

  assert.equal(store.search("zebrafish")[0]?.path, "Reading/frontend.md");
  assert.equal(store.search("cobra").length, 0);
  store.close();
});

test("the index survives reopening and rebuilds on demand", () => {
  Store.open(vault).refresh();
  const reopened = Store.open(vault);
  assert.equal(reopened.refresh().unchanged, 3);
  reopened.close();

  const rebuilt = Store.open(vault, { rebuild: true });
  assert.equal(rebuilt.refresh().added, 3);
  rebuilt.close();
});

test("search ranks a title match above a passing body mention", () => {
  const store = Store.open(vault);
  store.refresh();
  const hits = store.search("interview");
  assert.deepEqual(
    hits.map((h) => h.path),
    ["Career HQ/interview-prep.md", "Reading/frontend.md"],
  );
  assert.match(hits[0]!.snippet, /\[Interview\]/);
  store.close();
});

test("search: OR semantics, stemming, alias match, path and tag filters", () => {
  const store = Store.open(vault);
  store.refresh();
  assert.equal(store.search("designing frontend systems")[0]?.path, "Career HQ/interview-prep.md");
  assert.equal(store.search("health coverage")[0]?.path, "Finance/cobra.md");
  assert.deepEqual(
    store.search("interview", { path: "Reading" }).map((h) => h.path),
    ["Reading/frontend.md"],
  );
  assert.deepEqual(
    store.search("interview", { tag: "#Career" }).map((h) => h.path),
    ["Career HQ/interview-prep.md"],
  );
  store.close();
});

test("resolve follows wiki-link rules: path, name, title, alias, ambiguity", () => {
  const store = Store.open(vault);
  store.refresh();
  write("Other/interview-prep.md", "# Duplicate name\n");
  store.refresh();

  assert.deepEqual(store.resolve("Finance/cobra"), ["Finance/cobra.md"]);
  assert.deepEqual(store.resolve("cobra.md"), ["Finance/cobra.md"]);
  assert.deepEqual(store.resolve("health coverage"), ["Finance/cobra.md"]);
  assert.deepEqual(store.resolve("Reading list"), ["Reading/frontend.md"]);
  assert.deepEqual(store.resolve("interview-prep"), ["Career HQ/interview-prep.md", "Other/interview-prep.md"]);
  assert.deepEqual(store.resolve("nothing here"), []);
  store.close();
});

test("match expression: stop words dropped, phrases kept, input never reaches FTS5 unquoted", () => {
  assert.equal(toMatchExpression("what are my interview notes"), '"interview" OR "notes"');
  assert.equal(toMatchExpression('"system design" prep'), '"system design" OR "prep"');
  assert.equal(toMatchExpression('AND ( NEAR* "'), '"near"');
  assert.equal(toMatchExpression("what is it"), '"what" OR "is" OR "it"');
  assert.equal(toMatchExpression("   "), "");
});

function pick(s: { added: number; updated: number; removed: number; unchanged: number }) {
  return { added: s.added, updated: s.updated, removed: s.removed, unchanged: s.unchanged };
}
