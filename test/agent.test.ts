import "./isolate.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { context, install } from "../src/agent.js";
import type { Config } from "../src/config.js";
import { addEntry } from "../src/log.js";
import { Store } from "../src/store.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "brain-home-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("pi: skill goes to the shared ~/.agents/skills (Pi reads it) plus the extension; reinstall is a no-op", () => {
  const first = install("pi", { home });
  assert.deepEqual(
    first.files.map((f) => [f.path.slice(home.length), f.status]),
    [
      ["/.agents/skills/brain/SKILL.md", "written"],
      ["/.pi/agent/extensions/brain-memory.ts", "written"],
    ],
  );
  assert.match(readFileSync(join(home, ".agents/skills/brain/SKILL.md"), "utf8"), /^---\nname: brain\ndescription: /);
  assert.match(readFileSync(join(home, ".pi/agent/extensions/brain-memory.ts"), "utf8"), /before_agent_start/);
  assert.ok(install("pi", { home }).files.every((f) => f.status === "unchanged"));
});

test("pi: warns when a second 'brain' skill would collide in ~/.pi/agent/skills", () => {
  mkdirSync(join(home, ".pi/agent/skills/brain"), { recursive: true });
  assert.equal(install("pi", { home }).warnings.length, 1);
});

test("claude: skill under ~/.claude/skills; settings are printed, never edited", () => {
  const r = install("claude", { home });
  assert.deepEqual(r.files.map((f) => f.path.slice(home.length)), ["/.claude/skills/brain/SKILL.md"]);
  assert.ok(r.next.join("\n").includes('"command": "brain context"'));
  assert.ok(!existsSync(join(home, ".claude/settings.json")));
});

test("never replaces a file brain did not write, unless forced; --dry-run writes nothing", () => {
  const path = join(home, ".agents/skills/brain/SKILL.md");
  mkdirSync(join(home, ".agents/skills/brain"), { recursive: true });
  writeFileSync(path, "---\nname: my-own-brain\n---\nmine\n");
  assert.equal(install("agents", { home }).files[0]!.status, "conflict");
  assert.equal(readFileSync(path, "utf8"), "---\nname: my-own-brain\n---\nmine\n");
  assert.equal(install("agents", { home, force: true, dryRun: true }).files[0]!.status, "written");
  assert.match(readFileSync(path, "utf8"), /mine/);
  install("agents", { home, force: true });
  assert.match(readFileSync(path, "utf8"), /^---\nname: brain/);
});

test("context: primer with recent memory titles, newest first, duplicates across machines shown once", () => {
  const vault = join(home, "vault");
  mkdirSync(vault);
  const cfg = (machine: string): Config => ({ logDir: "log", machine, exports: [], userConfigPath: "", sync: "none", integrations: {}, as: null, lifecycleWindows: {}, lintMaxLines: {} });
  addEntry(vault, cfg("mini"), { kind: "learning", title: "Shared lesson", created: new Date("2026-01-01T00:00:00Z") });
  addEntry(vault, cfg("laptop"), { kind: "learning", title: "Shared lesson", created: new Date("2026-01-02T00:00:00Z") });
  addEntry(vault, cfg("mini"), { kind: "decision", title: "Use brain", created: new Date("2026-01-03T00:00:00Z") });
  const store = Store.open(vault);
  store.refresh();
  const text = context(store, cfg("mini"), 5);
  assert.match(text, /^<brain>\n/);
  assert.match(text, /<\/brain>$/);
  assert.match(text, /Recent memory \(newest first\):\n- 2026-01-03 \[decision\] Use brain\n- 2026-01-02 \[learning\] Shared lesson\n<\/brain>$/);
  store.close();
});
