// `brain sync`: commit new log entries, pull, push. Plain git, no service.
//
// It commits only what brain owns — the log folder and brain.json — so it never
// sweeps a half-written note into a commit behind the user's back. Pulls rebase
// with --autostash, so other uncommitted edits survive. Because log entries are
// always new files, two machines syncing never conflict on them; a conflict can
// only come from notes a person edited on both machines, and then sync stops
// and says which files, rather than guessing.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";

export interface SyncResult {
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

export function sync(vault: string, cfg: Config, opts: { push?: boolean } = {}): SyncResult {
  const git = (...args: string[]) => run(vault, args);

  try {
    if (git("rev-parse", "--is-inside-work-tree") !== "true") throw new Error();
  } catch {
    throw new SyncError("not_git", `${vault} is not a git repository: run 'git init' and add a remote to sync`);
  }

  const owned = [cfg.logDir, "brain.json"].filter((p) => existsSync(join(vault, p)));
  let committed = 0;
  if (owned.length) {
    git("add", "--", ...owned);
    const staged = git("diff", "--cached", "--name-only", "--", ...owned)
      .split("\n")
      .filter(Boolean);
    if (staged.length) {
      git("commit", "--quiet", "-m", `brain: ${staged.length} log ${staged.length === 1 ? "entry" : "entries"} from ${cfg.machine}`, "--", ...owned);
      committed = staged.length;
    }
  }

  let upstream: string | null = null;
  try {
    upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
  } catch {
    upstream = null;
  }
  if (!upstream) return { committed, pulled: 0, pushed: false, remote: false };

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
  return { committed, pulled, pushed, remote: true };
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
