import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

test("the committed dist/src is exactly what src compiles to", () => {
  const out = mkdtempSync(join(tmpdir(), "brain-dist-drift-"));
  try {
    execFileSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", ROOT, "--outDir", out], { cwd: ROOT });
    const compiledRoot = join(out, "src");
    const compiled = readdirSync(compiledRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(out, join(entry.parentPath, entry.name)))
      .map((file) => `dist/${file.split(sep).join("/")}`)
      .sort();
    const committed = run("git", ["ls-files", "--", "dist/src"], ROOT).trim().split("\n").filter(Boolean).sort();
    assert.deepEqual(committed, compiled, "rebuild and commit dist/src with every src change");
    for (const file of committed) {
      const tracked = execFileSync("git", ["show", `:${file}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
      assert.ok(tracked.equals(readFileSync(join(out, file.slice("dist/".length)))), `${file} is stale: rebuild and commit dist/src`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a global install from a git URL needs no build tools and yields a runnable brain executable", () => {
  const scratch = mkdtempSync(join(tmpdir(), "brain-git-install-"));
  const repo = join(scratch, "repo");
  const prefix = join(scratch, "prefix");
  const tools = join(scratch, "tools");

  try {
    mkdirSync(repo);
    mkdirSync(tools);

    const files = run("git", ["ls-files", "-co", "--exclude-standard"], ROOT).trim().split("\n").filter(Boolean);
    for (const file of files) {
      const destination = join(repo, file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(ROOT, file), destination, { dereference: false });
    }

    const tsc = join(tools, "tsc");
    writeFileSync(tsc, "#!/bin/sh\necho 'the install artifact must not need a compiler' >&2\nexit 97\n");
    chmodSync(tsc, 0o755);
    const npmCli = process.env.npm_execpath ?? realpathSync(run("/usr/bin/env", ["which", "npm"], ROOT).trim());

    const env = {
      HOME: scratch,
      PATH: `${tools}:/usr/bin:/bin`,
      npm_config_cache: join(scratch, "npm-cache"),
      npm_config_update_notifier: "false",
    };
    const git = (...args: string[]) => run("git", ["-c", "user.name=brain", "-c", "user.email=brain@example.invalid", ...args], repo);
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "snapshot");

    const installed = spawnSync(process.execPath, [npmCli, "install", "--global", "--prefix", prefix, `git+file://${repo}`], {
      cwd: scratch,
      encoding: "utf8",
      env,
    });
    assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);

    const brain = spawnSync(join(prefix, "bin", "brain"), ["--help"], {
      cwd: scratch,
      encoding: "utf8",
      env: { ...process.env, HOME: scratch, BRAIN_VAULT: "" },
    });
    assert.equal(brain.status, 0, `${brain.error ?? ""}\n${brain.stderr}`);
    assert.match(brain.stdout, /brain .* headless memory/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
