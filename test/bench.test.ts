import "./isolate.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "../../bin/brain.js");
const BENCH = resolve(HERE, "../../examples/bench");
const DEMO = join(BENCH, "demo");
const SCRIPT = join(BENCH, "bin", "brain-bench");

interface Fixture {
  root: string;
  vault: string;
  bin: string;
  env: NodeJS.ProcessEnv;
}

// A copy of the demo vault: installing an extension writes its enablement note
// into the vault, and the checked-in demo must stay as it is.
function fixture(t: { after(fn: () => void): void }): Fixture {
  const root = mkdtempSync(join(tmpdir(), "brain-bench-"));
  const vault = join(root, "vault");
  cpSync(DEMO, vault, { recursive: true });
  mkdirSync(join(vault, ".obsidian"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BRAIN_VAULT: vault,
    BRAIN_CONFIG: join(root, "config.json"),
    BRAIN_STATE_DIR: join(root, "state"),
    BRAIN_EXTENSIONS_DIR: join(root, "extensions"),
    BRAIN_MACHINE: "test-machine",
    BRAIN_AS: "",
    BRAIN_TELEMETRY: "0",
    BRAIN_POSTHOG_KEY: "",
    // No Obsidian CLI unless a test puts a fake one first on PATH.
    PATH: [bin, ...(process.env.PATH ?? "").split(delimiter).filter((dir) => !hasObsidian(dir))].join(delimiter),
  };
  delete env.CI;
  delete env.BRAIN_BIN;
  delete env.BRAIN_BIN_ARGS_JSON;
  delete env.BRAIN_EXTENSION_SCOPE;
  return { root, vault, bin, env };
}

function hasObsidian(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => /^obsidian(\.exe|\.cmd)?$/i.test(name));
  } catch {
    return false;
  }
}

function files(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), root) : [relative(root, join(dir, e.name))]))
    .sort();
}

function standalone(f: Fixture, args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, "--vault", f.vault], { cwd: f.root, env: f.env, encoding: "utf8" });
  return { code: r.status, stderr: r.stderr, body: JSON.parse(r.stdout) };
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// Install has no non-interactive approval; drive the real prompt through a pseudo-terminal.
function install(f: Fixture) {
  const command = [process.execPath, "--no-warnings=ExperimentalWarning", BIN, "ext", "install", BENCH].map(quote).join(" ");
  const script = process.platform === "darwin" ? `script -q -e /dev/null ${command}` : `script -q -e -c ${quote(command)} /dev/null`;
  return spawnSync("/bin/sh", ["-c", `(sleep 0.1; printf 'y\\n'; sleep 0.2) | ${script}`], { cwd: f.vault, env: f.env, encoding: "utf8" });
}

// Counts are the contract; wall-clock timings are not.
function withoutTimings(data: Record<string, any>) {
  return JSON.parse(JSON.stringify(data, (key, value) => (key === "ms" ? undefined : value)));
}

test("brain bench runs the demo questions as an installed extension, deterministically", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const installed = install(f);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);

  const run = () => {
    const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, "bench", "questions.jsonl", "--json"], {
      cwd: f.vault,
      env: f.env,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return { stderr: r.stderr, body: JSON.parse(r.stdout) };
  };
  const first = run();
  assert.equal(first.body.schema, "brain.v1");
  assert.equal(first.body.command, "bench");
  assert.equal(first.body.ok, true);
  const data = first.body.data;
  assert.equal(data.questions, 14);
  assert.deepEqual(Object.keys(data.methods), ["grep", "obsidian", "brain"]);
  assert.equal(data.methods.obsidian.available, false, "no Obsidian CLI is installed");
  assert.match(first.stderr, /skipping obsidian/, "a missing method is skipped loudly");
  assert.equal(data.methods.brain.totals.top5, 14);
  assert.ok(data.methods.brain.totals.top1 > data.methods.grep.totals.top1, "ranking puts the answer first more often than grep");
  for (const row of data.results) {
    assert.ok(row.grep.calls >= 1 && row.brain.calls === 3, `${row.id}: one search, the headings, one section`);
    assert.ok(row.brain.tokens > 0 && row.grep.tokens > 0);
  }
  assert.deepEqual(withoutTimings(run().body.data), withoutTimings(data), "a second run gives the same counts");

  const standaloneRun = standalone(f, ["questions.jsonl", "--json"]);
  assert.equal(standaloneRun.code, 0);
  assert.deepEqual(withoutTimings(standaloneRun.body.data), withoutTimings(data), "the extension and the bare script agree");
});

test("the questions file is never an answer, and a markdown one inside the vault is refused", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const before = files(f.vault);
  writeFileSync(join(f.vault, "answer-key.jsonl"), JSON.stringify({ id: "key", question: "zebracorn quokkafish", expect: "MEMORY.md" }) + "\n");
  const r = standalone(f, ["answer-key.jsonl", "--json"]);
  assert.equal(r.code, 0, JSON.stringify(r.body));
  const row = r.body.data.results[0];
  assert.equal(row.grep.rank, null, "grep does not read the questions file");
  assert.equal(row.grep.calls, 2, "both words were grepped and matched nothing");
  assert.equal(row.brain.rank, null, "brain never indexes the questions file");
  assert.deepEqual(files(f.vault), [...before, "answer-key.jsonl"].sort(), "a standalone run writes nothing into the vault");

  writeFileSync(join(f.vault, "questions.md"), JSON.stringify({ question: "x", expect: "MEMORY.md" }) + "\n");
  const refused = standalone(f, ["questions.md", "--json"]);
  assert.equal(refused.code, 2);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.error.code, "usage");

  const missing = standalone(f, ["nope.jsonl", "--json"]);
  assert.equal(missing.code, 3);
  assert.equal(missing.body.error.code, "not_found");
});

test("the Obsidian CLI method searches with OR-ed words and reads the top result", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const log = join(f.root, "obsidian-calls.log");
  const fake = join(f.bin, "obsidian");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "version") { console.log("1.12.7"); process.exit(0); }
if (args[1] === "search") { console.log(JSON.stringify(["Projects/Garden Plan.md", "Recipes/Sourdough starter.md"])); process.exit(0); }
if (args[1] === "read") { console.log("# note body"); process.exit(0); }
process.exit(1);
`,
  );
  chmodSync(fake, 0o755);
  writeFileSync(join(f.root, "q.jsonl"), JSON.stringify({ id: "s", question: "how often should I feed the sourdough starter", expect: "Recipes/Sourdough starter" }) + "\n");
  const r = standalone(f, [join(f.root, "q.jsonl"), "--methods", "obsidian", "--json"]);
  assert.equal(r.code, 0, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body.data.methods), ["obsidian"]);
  const row = r.body.data.results[0];
  assert.equal(row.obsidian.rank, 2, "expect may omit .md");
  assert.equal(row.obsidian.top5, true);
  assert.equal(row.obsidian.calls, 2);
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const search = calls.find((c) => c[1] === "search")!;
  assert.equal(search[0], "vault=vault");
  assert.ok(search.includes("query=often OR feed OR sourdough OR starter"), search.join(" "));
  assert.deepEqual(calls.find((c) => c[1] === "read"), ["vault=vault", "read", "path=Projects/Garden Plan.md"]);
});
