// Two machines, one remote, both writing memory: the scenario brain sync exists for.
import "./isolate.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/brain.js");
let root: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function machine(name: string) {
  const vault = join(root, name);
  const learnings = join(root, `fm-${name}`, "data", "learnings.md");
  const config = join(root, `config-${name}.json`);
  writeFileSync(config, JSON.stringify({ machine: name, exports: [{ kind: "learning", path: learnings }] }));
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, ...args, "--json"], {
      cwd: vault,
      env: { ...process.env, BRAIN_VAULT: vault, BRAIN_CONFIG: config, BRAIN_MACHINE: "" },
      encoding: "utf8",
    });
    return { code: r.status, body: JSON.parse(r.stdout) };
  };
  return { vault, learnings, run };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brain-sync-"));
  git(root, "init", "-q", "--bare", "-b", "main", "remote.git");
  const mini = join(root, "mini");
  git(root, "init", "-q", "-b", "main", "mini");
  mkdirSync(join(mini, ".obsidian"));
  writeFileSync(join(mini, ".gitignore"), ".brain/\n");
  writeFileSync(join(mini, "Home.md"), "# Home\n");
  for (const repo of [mini]) {
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
  }
  git(mini, "add", "-A");
  git(mini, "commit", "-qm", "init");
  git(mini, "remote", "add", "origin", join(root, "remote.git"));
  git(mini, "push", "-q", "-u", "origin", "main");
  git(root, "clone", "-q", join(root, "remote.git"), "laptop");
  const laptop = join(root, "laptop");
  git(laptop, "config", "user.email", "t@example.com");
  git(laptop, "config", "user.name", "t");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("two machines log concurrently, sync, and end with identical memory and no conflict", () => {
  const mini = machine("mini");
  const laptop = machine("laptop");

  assert.equal(mini.run("log", "add", "learning", "Mac mini runs the overnight jobs").code, 0);
  assert.equal(laptop.run("log", "add", "learning", "Laptop has no Docker", "--body", "Use the mini.").code, 0);

  const s1 = mini.run("sync");
  assert.equal(s1.code, 0);
  assert.equal(s1.body.data.committed, 1);
  assert.equal(s1.body.data.pushed, true);

  const s2 = laptop.run("sync");
  assert.equal(s2.code, 0, JSON.stringify(s2.body));
  assert.equal(s2.body.data.pulled, 1);
  assert.equal(s2.body.data.pushed, true);

  assert.equal(mini.run("sync").body.data.pulled, 1);

  const a = readFileSync(mini.learnings, "utf8");
  assert.equal(a, readFileSync(laptop.learnings, "utf8"));
  assert.match(a, /- Mac mini runs the overnight jobs\n- Laptop has no Docker\n {2}Use the mini\.\n$/);
  assert.equal(git(mini.vault, "status", "--porcelain"), "");
});

test("two machines ingest sources concurrently and sync both immutable pairs without conflict", () => {
  const mini = machine("mini");
  const laptop = machine("laptop");
  const miniInput = join(root, "mini-paper.pdf");
  const laptopInput = join(root, "laptop-notes.pdf");
  writeFileSync(miniInput, "paper bytes\n");
  writeFileSync(laptopInput, "meeting notes\n");

  const a = mini.run("ingest", miniInput, "--title", "Concurrent source");
  const b = laptop.run("ingest", laptopInput, "--title", "Concurrent source");
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  assert.match(a.body.data.path, /-mini-/);
  assert.match(b.body.data.path, /-laptop-/);

  assert.equal(mini.run("sync").code, 0);
  const second = laptop.run("sync");
  assert.equal(second.code, 0, JSON.stringify(second.body));
  assert.equal(second.body.data.pulled, 1);
  assert.equal(second.body.data.pushed, true);
  assert.equal(mini.run("sync").body.data.pulled, 1);

  for (const path of [a.body.data.path, a.body.data.path + ".source.md", b.body.data.path, b.body.data.path + ".source.md"]) {
    assert.equal(readFileSync(join(mini.vault, path), "utf8"), readFileSync(join(laptop.vault, path), "utf8"));
  }
  assert.equal(git(mini.vault, "status", "--porcelain"), "");
});

test("sync commits only the log and sources, never a note being written", () => {
  const mini = machine("mini");
  mini.run("log", "add", "decision", "Use brain for memory");
  writeFileSync(join(mini.vault, "Draft.md"), "half-written\n");
  assert.equal(mini.run("sync").code, 0);
  assert.equal(git(mini.vault, "status", "--porcelain"), "?? Draft.md");
  assert.match(git(join(root, "remote.git"), "log", "-1", "--format=%s"), /^brain: 1 log entry from mini$/);
});

test("a note edited on both machines stops sync with exit 5 and names the file", () => {
  const mini = machine("mini");
  const laptop = machine("laptop");
  writeFileSync(join(mini.vault, "Home.md"), "# Home\nmini edit\n");
  git(mini.vault, "commit", "-qam", "mini edit");
  git(mini.vault, "push", "-q");
  writeFileSync(join(laptop.vault, "Home.md"), "# Home\nlaptop edit\n");
  git(laptop.vault, "commit", "-qam", "laptop edit");

  const r = laptop.run("sync");
  assert.equal(r.code, 5);
  assert.equal(r.body.error.code, "sync_conflict");
  assert.deepEqual(r.body.error.files, ["Home.md"]);
  // The rebase was aborted: the laptop is back on its own commit, not mid-rebase.
  assert.equal(git(laptop.vault, "log", "-1", "--format=%s"), "laptop edit");
  assert.equal(git(laptop.vault, "status", "--porcelain"), "");
});

test("no git means sync mode none unless git is asked for; no upstream is reported", () => {
  const solo = join(root, "solo");
  mkdirSync(join(solo, ".obsidian"), { recursive: true });
  const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, "sync", "--json"], {
    cwd: solo,
    env: { ...process.env, BRAIN_VAULT: solo, BRAIN_CONFIG: join(root, "none.json"), BRAIN_MACHINE: "solo" },
    encoding: "utf8",
  });
  // "auto" (the default) on a folder without git means another service syncs it.
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).data.mode, "none");
  // Asking for git explicitly on a folder without git is an error.
  writeFileSync(join(solo, "brain.json"), JSON.stringify({ sync: "git" }));
  const forced = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, "sync", "--json"], {
    cwd: solo,
    env: { ...process.env, BRAIN_VAULT: solo, BRAIN_CONFIG: join(root, "none.json"), BRAIN_MACHINE: "solo" },
    encoding: "utf8",
  });
  assert.equal(forced.status, 1);
  assert.equal(JSON.parse(forced.stdout).error.code, "not_git");
  rmSync(join(solo, "brain.json"));

  git(solo, "init", "-q", "-b", "main");
  git(solo, "config", "user.email", "t@example.com");
  git(solo, "config", "user.name", "t");
  const local = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, "log", "add", "learning", "x"], {
    cwd: solo,
    env: { ...process.env, BRAIN_VAULT: solo, BRAIN_CONFIG: join(root, "none.json"), BRAIN_MACHINE: "solo" },
  });
  assert.equal(local.status, 0);
  const s = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, "sync", "--json"], {
    cwd: solo,
    env: { ...process.env, BRAIN_VAULT: solo, BRAIN_CONFIG: join(root, "none.json"), BRAIN_MACHINE: "solo" },
    encoding: "utf8",
  });
  const body = JSON.parse(s.stdout);
  assert.equal(s.status, 0);
  assert.equal(body.data.remote, false);
  assert.equal(body.data.committed, 1);
});
