// `brain path`: every name resolves through the same code as the index,
// telemetry and doctor, and printing a location never creates it.
import "./isolate.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PATH_NAMES } from "../src/paths.js";
import { indexDir } from "../src/store.js";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/brain.js");
let root: string;
let vault: string;

function brain(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, ...args], {
    cwd: vault,
    env: { ...process.env, BRAIN_VAULT: "", BRAIN_AS: "", BRAIN_STATE_DIR: join(root, "state"), BRAIN_CONFIG: join(root, "machine.json"), ...env },
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "brain-path-")));
  vault = join(root, "My Vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  writeFileSync(join(vault, "brain.json"), JSON.stringify({ log: { dir: "memory" }, integrations: { coach: { read: ["Career/"], write: ["interview"] } } }));
});

after(() => rmSync(root, { recursive: true, force: true }));

test("every name prints one bare absolute path, so $(brain path log) works", () => {
  const expected: Record<string, string> = {
    vault,
    log: join(vault, "memory"),
    sources: join(vault, "sources"),
    config: join(vault, "brain.json"),
    "user-config": join(root, "machine.json"),
    state: indexDir(vault, join(root, "state")),
    index: join(indexDir(vault, join(root, "state")), "index.db"),
    "telemetry-queue": join(root, "state", "telemetry-queue.jsonl"),
  };
  assert.deepEqual(Object.keys(expected), [...PATH_NAMES]);
  for (const name of PATH_NAMES) {
    const r = brain(["path", name]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, expected[name] + "\n", name);
  }
});

test("--json: one name, or an object of all of them, each with whether it exists yet", () => {
  const one = JSON.parse(brain(["path", "config", "--json"]).stdout);
  assert.deepEqual(one.data, { name: "config", path: join(vault, "brain.json"), exists: true });
  const all = JSON.parse(brain(["path", "--json"]).stdout).data.paths;
  assert.deepEqual(Object.keys(all), [...PATH_NAMES]);
  assert.equal(all.vault.exists, true);
  assert.equal(all.index.exists, false);
});

test("reads only: printing every path creates no file or directory", () => {
  const fresh = join(root, "untouched-state");
  brain(["path"], { BRAIN_STATE_DIR: fresh });
  brain(["path", "--json"], { BRAIN_STATE_DIR: fresh });
  brain(["path", "index"], { BRAIN_STATE_DIR: fresh });
  assert.equal(existsSync(fresh), false);
  assert.deepEqual(readdirSync(vault).sort(), [".obsidian", "brain.json"]);
});

test("overrides: --vault, BRAIN_VAULT, BRAIN_CONFIG and BRAIN_STATE_DIR all move the answer", () => {
  const other = join(root, "Other");
  mkdirSync(join(other, ".obsidian"), { recursive: true });
  assert.equal(brain(["path", "vault", "--vault", other]).stdout.trim(), other);
  assert.equal(brain(["path", "log"], { BRAIN_VAULT: other }).stdout.trim(), join(other, "log"));
  assert.equal(brain(["path", "user-config"], { BRAIN_CONFIG: join(root, "elsewhere.json") }).stdout.trim(), join(root, "elsewhere.json"));
  assert.equal(brain(["path", "telemetry-queue"], { BRAIN_STATE_DIR: join(root, "s2") }).stdout.trim(), join(root, "s2", "telemetry-queue.jsonl"));
});

test("an unknown name is a usage error listing the valid names", () => {
  const r = brain(["path", "nope", "--json"]);
  assert.equal(r.code, 2);
  const body = JSON.parse(r.stdout);
  assert.equal(body.error.code, "usage");
  assert.deepEqual(body.error.names, [...PATH_NAMES]);
  assert.equal(brain(["path", "log", "index"]).code, 2);
});

test("under an integration the paths are the same, and --json names the scope", () => {
  const scoped = JSON.parse(brain(["path", "log", "--json"], { BRAIN_AS: "coach" }).stdout).data;
  assert.equal(scoped.path, join(vault, "memory"));
  assert.equal(scoped.as, "coach");
});

test("doctor reports the index where brain path says it is", () => {
  const checks = JSON.parse(brain(["doctor", "--json"]).stdout).data.checks as { check: string; detail: string }[];
  const state = brain(["path", "state"]).stdout.trim();
  assert.ok(checks.find((c) => c.check === "index")!.detail.startsWith(state + " "));
});
