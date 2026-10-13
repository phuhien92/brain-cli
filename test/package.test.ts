import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

test("a clean package artifact globally installs without build tools and includes a runnable brain executable", () => {
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
    const packed = spawnSync(process.execPath, [npmCli, "pack", "--json", "--pack-destination", scratch], {
      cwd: repo,
      encoding: "utf8",
      env,
    });
    assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
    const [{ filename }] = JSON.parse(packed.stdout) as [{ filename: string }];

    const installed = spawnSync(process.execPath, [npmCli, "install", "--global", "--prefix", prefix, join(scratch, filename)], {
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
