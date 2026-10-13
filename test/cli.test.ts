// Runs the real executable, so the shebang, the JSON envelope and the exit
// codes are what an agent actually gets.
import "./isolate.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/brain.js");
let vault: string;

function brain(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, ...args], {
    cwd: opts.cwd ?? vault,
    env: { ...process.env, BRAIN_VAULT: "", ...opts.env },
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function json(args: string[], opts?: Parameters<typeof brain>[1]) {
  const r = brain([...args, "--json"], opts);
  return { code: r.code, body: JSON.parse(r.stdout) };
}

before(() => {
  vault = mkdtempSync(join(tmpdir(), "brain-cli-"));
  mkdirSync(join(vault, ".obsidian"));
  mkdirSync(join(vault, "notes"));
  mkdirSync(join(vault, "a"));
  writeFileSync(join(vault, "notes/deploy.md"), "---\ntags: [ops]\n---\n# Deploy gotchas\npnpm cache breaks on the mac mini.\n[[runbook]]\n");
  writeFileSync(join(vault, "notes/dup.md"), "one\n");
  writeFileSync(join(vault, "a/dup.md"), "two\n");
});

after(() => rmSync(vault, { recursive: true, force: true }));

test("finds the vault from a nested folder via .obsidian/", () => {
  const { code, body } = json(["index"], { cwd: join(vault, "notes") });
  assert.equal(code, 0);
  assert.equal(body.vault, realpathSync(vault));
  assert.equal(body.data.notes, 3);
});

test("a vault reached through a symlink is reported by its real path (macOS /var → /private/var)", () => {
  const link = join(tmpdir(), `brain-link-${process.pid}`);
  symlinkSync(vault, link);
  try {
    const viaEnv = json(["index"], { env: { BRAIN_VAULT: link } });
    const viaCwd = json(["index"], { cwd: join(link, "notes") });
    assert.equal(viaEnv.body.vault, realpathSync(vault));
    assert.equal(viaCwd.body.vault, realpathSync(vault));
  } finally {
    rmSync(link);
  }
});

test("search --json returns the versioned envelope with ranked results", () => {
  const { code, body } = json(["search", "pnpm", "mac", "mini"]);
  assert.equal(code, 0);
  assert.equal(body.schema, "brain.v1");
  assert.equal(body.ok, true);
  assert.equal(body.command, "search");
  assert.equal(typeof body.index.ms, "number");
  assert.equal(body.data.results[0].path, "notes/deploy.md");
  assert.deepEqual(body.data.results[0].tags, ["ops"]);
});

test("get returns content, and --meta drops it", () => {
  const full = json(["get", "deploy"]);
  assert.match(full.body.data.content, /pnpm cache/);
  assert.deepEqual(full.body.data.links, [{ target: "runbook", heading: null }]);
  const meta = json(["get", "Deploy gotchas", "--meta"]);
  assert.equal(meta.body.data.content, undefined);
  assert.equal(meta.body.data.title, "Deploy gotchas");
});

test("exit codes: not found 3, ambiguous 4 with candidates, usage 2, no vault 1", () => {
  assert.equal(json(["get", "missing"]).code, 3);

  const amb = json(["get", "dup"]);
  assert.equal(amb.code, 4);
  assert.equal(amb.body.ok, false);
  assert.deepEqual(amb.body.error.candidates, ["a/dup.md", "notes/dup.md"]);

  assert.equal(json(["search"]).code, 2);
  assert.equal(json(["search", "x", "--limit", "0"]).code, 2);
  assert.equal(json(["frobnicate"]).code, 2);
  assert.equal(json(["search", "--bogus"]).code, 2);

  const none = json(["index"], { cwd: tmpdir() });
  assert.equal(none.code, 1);
  assert.equal(none.body.error.code, "no_vault");
});

test("--quiet suppresses human output; errors still go to stderr", () => {
  assert.equal(brain(["index", "-q"]).stdout, "");
  const r = brain(["get", "missing", "-q"]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /no note matches/);
});
