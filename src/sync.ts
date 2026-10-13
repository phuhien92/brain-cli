// `brain sync`: commit new log entries and sources, pull, push. Plain git, no service.
//
// It commits only what brain owns — the log folder, ingested source pairs in sources/ and brain.json — so it never
// sweeps a half-written note into a commit behind the user's back. Pulls rebase
// with --autostash, so other uncommitted edits survive. Because log entries and
// source pairs are always new machine-named files, two machines syncing never
// conflict on them; a conflict can only come from notes a person edited on both machines, and then sync stops
// and says which files, rather than guessing.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { SOURCES_DIR, SOURCE_SIDECAR_SUFFIX, sourceSidecars } from "./source.js";

// Only sources not yet committed go on git's command line, so argv stays
// bounded; past this a sync refuses rather than failing with E2BIG.
const MAX_SOURCE_PATHSPEC_BYTES = 100_000;

export interface SyncResult {
  mode: "git" | "none" | "command";
  committed: number; // files in the commit brain made, 0 if none
  pulled: number; // commits brought in by the pull
  pushed: boolean;
  remote: boolean;
}

export class SyncError extends Error {
  constructor(
    readonly code: "not_git" | "sync_conflict" | "git_failed",
    message: string,
    readonly files: string[] = [],
  ) {
    super(message);
  }
}

export function isGitRepo(vault: string): boolean {
  try {
    return run(vault, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

export function resolveSyncMode(vault: string, cfg: Config): "git" | "none" | "command" {
  if (typeof cfg.sync === "object") return "command";
  if (cfg.sync === "auto") return isGitRepo(vault) ? "git" : "none";
  return cfg.sync;
}

export function sync(vault: string, cfg: Config, opts: { push?: boolean } = {}): SyncResult {
  const mode = resolveSyncMode(vault, cfg);
  if (mode === "none") {
    // Something else (iCloud, Dropbox, Syncthing, Obsidian Sync) moves the
    // files; one-file-per-entry is what keeps that conflict-free.
    return { mode, committed: 0, pulled: 0, pushed: false, remote: false };
  }
  if (mode === "command") {
    const command = (cfg.sync as { command: string }).command;
    try {
      execFileSync(process.platform === "win32" ? "cmd" : "sh", process.platform === "win32" ? ["/c", command] : ["-c", command], {
        cwd: vault,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, BRAIN_VAULT: vault, BRAIN_LOG_DIR: cfg.logDir, BRAIN_MACHINE: cfg.machine },
      });
    } catch (err) {
      const e = err as { stderr?: Buffer; message: string };
      throw new SyncError("git_failed", `sync command failed: ${(e.stderr?.toString() || e.message).trim().split("\n").slice(-3).join(" ")}`);
    }
    return { mode, committed: 0, pulled: 0, pushed: false, remote: true };
  }

  const git = (...args: string[]) => run(vault, args);
  if (!isGitRepo(vault)) {
    throw new SyncError("not_git", `${vault} is not a git repository: run 'git init' and add a remote, or set "sync": "none" in brain.json`);
  }

  const managed = new Set(sourceSidecars(vault).flatMap((sidecar) => [sidecar.slice(0, -SOURCE_SIDECAR_SUFFIX.length), sidecar]));
  const pending = [
    ...git("ls-files", "-z", "--others", "--modified", "--exclude-standard", "--", SOURCES_DIR).split("\0"),
    ...git("diff", "--cached", "--name-only", "--relative", "-z", "--", SOURCES_DIR).split("\0"),
  ];
  const sources = [...new Set(pending)].filter((p) => managed.has(p) && existsSync(join(vault, p)));
  if (sources.join(" ").length > MAX_SOURCE_PATHSPEC_BYTES) {
    throw new SyncError(
      "git_failed",
      `${sources.length} new source files are too many to commit in one sync; commit them in ${SOURCES_DIR}/ with git, then run brain sync again`,
    );
  }
  const owned = [cfg.logDir, ...sources, "brain.json"].filter((p) => existsSync(join(vault, p)));
  let committed = 0;
  if (owned.length) {
    git("add", "--", ...owned);
    const staged = git("diff", "--cached", "--name-only", "--", ...owned)
      .split("\n")
      .filter(Boolean);
    if (staged.length) {
      const onlyLog = staged.every((path) => path.startsWith(`${cfg.logDir}/`));
      const message = onlyLog
        ? `brain: ${staged.length} log ${staged.length === 1 ? "entry" : "entries"} from ${cfg.machine}`
        : `brain: ${staged.length} owned ${staged.length === 1 ? "file" : "files"} from ${cfg.machine}`;
      git("commit", "--quiet", "-m", message, "--", ...owned);
      committed = staged.length;
    }
  }

  let upstream: string | null = null;
  try {
    upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
  } catch {
    upstream = null;
  }
  if (!upstream) return { mode, committed, pulled: 0, pushed: false, remote: false };

  // Count what arrived by how far the upstream ref moved, not HEAD: a rebase
  // rewrites this machine's own commits, which are not "pulled".
  const upstreamBefore = git("rev-parse", "@{upstream}");
  try {
    git("pull", "--rebase", "--autostash", "--quiet");
  } catch (err) {
    const conflicted = safe(() => git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean)) ?? [];
    const inRebase = ["rebase-merge", "rebase-apply"].some((d) => {
      const p = safe(() => git("rev-parse", "--git-path", d));
      return p ? existsSync(join(vault, p)) || existsSync(p) : false;
    });
    if (inRebase) safe(() => git("rebase", "--abort"));
    if (conflicted.length) {
      throw new SyncError(
        "sync_conflict",
        `the same notes were edited on two machines; resolve them in git, then sync again`,
        conflicted,
      );
    }
    throw new SyncError("git_failed", `git pull failed: ${(err as Error).message}`);
  }
  const pulled = Number(git("rev-list", "--count", `${upstreamBefore}..@{upstream}`));

  let pushed = false;
  if (opts.push !== false) {
    const ahead = Number(git("rev-list", "--count", "@{upstream}..HEAD"));
    if (ahead > 0) {
      try {
        git("push", "--quiet");
        pushed = true;
      } catch (err) {
        throw new SyncError("git_failed", `git push failed: ${(err as Error).message}`);
      }
    }
  }
  return { mode, committed, pulled, pushed, remote: true };
}

function run(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error((e.stderr || e.message).trim().split("\n").slice(-3).join(" "));
  }
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
