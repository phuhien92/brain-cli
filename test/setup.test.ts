import "./isolate.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { findVaultCandidates, profileFile, profileLine, recommendSync } from "../src/setup.js";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/brain.js");
let home: string;

function brain(args: string[], extra: Record<string, string> = {}, cwd?: string) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, BRAIN_CONFIG: join(home, ".config/brain/config.json"), SHELL: "/bin/zsh", DO_NOT_TRACK: "", ...extra };
  delete env.BRAIN_VAULT;
  const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, ...args], { cwd: cwd ?? home, env, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "brain-home-"));
  mkdirSync(join(home, "Library/Mobile Documents/iCloud~md~obsidian/Documents/Cloud Vault/.obsidian"), { recursive: true });
  mkdirSync(join(home, "Documents/Notes/.obsidian"), { recursive: true });
  mkdirSync(join(home, "Documents/Notes/Ideas"), { recursive: true });
  writeFileSync(join(home, "Documents/Notes/Ideas/plan.md"), "# Plan\nzebrafish launch\n");
  mkdirSync(join(home, ".claude"), { recursive: true });
});
after(() => rmSync(home, { recursive: true, force: true }));

test("finds vaults in iCloud's Obsidian folder, ~/Documents and above the working directory", () => {
  const found = findVaultCandidates(join(home, "Documents/Notes/Ideas"), home);
  assert.equal(found[0], join(home, "Documents/Notes"), "the vault you are standing in comes first");
  assert.ok(found.includes(join(home, "Library/Mobile Documents/iCloud~md~obsidian/Documents/Cloud Vault")));
});

test("sync recommendation: cloud folder → none; git → git; both → none with a warning", () => {
  const cloud = join(home, "Library/Mobile Documents/iCloud~md~obsidian/Documents/Cloud Vault");
  assert.equal(recommendSync(cloud).mode, "none");
  assert.equal(recommendSync(cloud).warning, null);
  const plain = join(home, "Documents/Notes");
  assert.equal(recommendSync(plain).mode, "none");
  spawnSync("git", ["init", "-q", plain]);
  assert.equal(recommendSync(plain).mode, "git");
  spawnSync("git", ["init", "-q", cloud]);
  assert.match(recommendSync(cloud).warning ?? "", /corrupt \.git/);
  rmSync(join(plain, ".git"), { recursive: true, force: true });
  rmSync(join(cloud, ".git"), { recursive: true, force: true });
});

test("profile line per shell, quoted", () => {
  assert.equal(profileFile("/h", "/bin/zsh"), "/h/.zshrc");
  assert.equal(profileFile("/h", "/usr/bin/fish"), "/h/.config/fish/config.fish");
  assert.equal(profileLine('/v/My "Vault"', "/h/.zshrc"), 'export BRAIN_VAULT="/v/My \\"Vault\\""');
});

test("without a terminal, setup needs --yes", () => {
  const r = brain(["setup", "--json"]);
  assert.equal(r.code, 2);
  assert.match(JSON.parse(r.stdout).error.message, /--yes/);
});

test("setup --yes writes only this machine's config, installs chosen agents, adds the profile line once", () => {
  const vault = join(home, "Documents/Notes");
  const r = brain(["setup", "--yes", "--vault", vault, "--machine", "Mac Mini", "--agents", "claude", "--telemetry", "no", "--profile", "--json"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const data = JSON.parse(r.stdout).data;
  assert.equal(data.choices.machine, "mac-mini");
  assert.equal(data.choices.sync, "none");

  const cfg = JSON.parse(readFileSync(join(home, ".config/brain/config.json"), "utf8"));
  assert.deepEqual(cfg, { machine: "mac-mini", sync: "none", vault });
  assert.ok(existsSync(join(home, ".claude/skills/brain/SKILL.md")));
  assert.ok(!existsSync(join(home, ".claude/settings.json")), "never edits the harness's settings");
  assert.equal(JSON.parse(brain(["telemetry", "--json"]).stdout).data.enabled, false);

  const rc = readFileSync(join(home, ".zshrc"), "utf8");
  assert.equal(rc.split(`export BRAIN_VAULT="${vault}"`).length - 1, 1);
  brain(["setup", "--yes", "--vault", vault, "--agents", "", "--profile", "--json"]);
  assert.equal(readFileSync(join(home, ".zshrc"), "utf8").split("BRAIN_VAULT").length - 1, 1, "not added twice");
  assert.equal(existsSync(join(vault, "brain.json")), false, "the vault is never written");
});

test("after setup, brain finds the vault from anywhere — no BRAIN_VAULT, no .obsidian above", () => {
  const r = brain(["search", "zebrafish", "--json"], {}, tmpdir());
  assert.equal(r.code, 0, r.stdout);
  assert.equal(JSON.parse(r.stdout).data.results[0].path, "Ideas/plan.md");
});
