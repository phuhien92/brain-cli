// A vault shared by several repos: each integration sees only its folders.
import "./isolate.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/brain.js");
let root: string;
let vault: string;
let userConfig: string;

function brain(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, ...args, "--json"], {
    cwd: vault,
    env: { ...process.env, BRAIN_VAULT: vault, BRAIN_CONFIG: userConfig, BRAIN_MACHINE: "mini", BRAIN_AS: "", ...env },
    encoding: "utf8",
  });
  return { code: r.status, body: JSON.parse(r.stdout) };
}

function write(rel: string, content: string) {
  mkdirSync(dirname(join(vault, rel)), { recursive: true });
  writeFileSync(join(vault, rel), content);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "brain-int-"));
  vault = join(root, "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  write("Career HQ/storybank.md", "# Storybank\nThe impersonation story.\n");
  write("Finance/severance.md", "# Severance\nThe impersonation of a bank statement.\n");
  write("firstmate/fleet.md", "# Fleet\nCrew notes.\n");
  write(
    "brain.json",
    JSON.stringify({
      sync: "none",
      integrations: {
        "interview-coach": { read: ["Career HQ"], write: ["interview"] },
        firstmate: { read: ["firstmate/"], write: ["learning"], views: { learning: { header: "<!-- stow -->" } } },
        everything: { read: ["*"], write: [] },
      },
    }),
  );
  userConfig = join(root, "config.json");
  writeFileSync(
    userConfig,
    JSON.stringify({ integrations: { firstmate: { views: { learning: join(root, "fm/data/learnings.md") } } } }),
  );
});
after(() => rmSync(root, { recursive: true, force: true }));

test("integrations lists every declared integration with this machine's view paths", () => {
  const r = brain(["integrations"]);
  assert.equal(r.code, 0);
  const names = r.body.data.integrations.map((i: { name: string }) => i.name);
  assert.deepEqual(names, ["interview-coach", "firstmate", "everything"]);
  const fm = r.body.data.integrations[1];
  assert.deepEqual(fm.read, ["firstmate/"]);
  assert.deepEqual(fm.views, [{ kind: "learning", path: join(root, "fm/data/learnings.md") }]);
});

test("search and get see only the acting integration's folders", () => {
  const all = brain(["search", "impersonation"]);
  assert.equal(all.body.data.results.length, 2);

  const coach = brain(["search", "impersonation"], { BRAIN_AS: "interview-coach" });
  assert.deepEqual(coach.body.data.results.map((h: { path: string }) => h.path), ["Career HQ/storybank.md"]);

  // Out of scope is "not found", so a restricted agent cannot probe for notes.
  const probe = brain(["get", "Finance/severance"], { BRAIN_AS: "interview-coach" });
  assert.equal(probe.code, 3);
  assert.equal(brain(["get", "Finance/severance"], { BRAIN_AS: "everything" }).code, 0);
  assert.equal(brain(["get", "Finance/severance", "--as", "firstmate"]).code, 3);
});

test("an integration writes only its kinds and reads its own log", () => {
  assert.equal(brain(["log", "add", "learning", "Crew lesson"], { BRAIN_AS: "firstmate" }).code, 0);
  const disposable = brain(["log", "add", "learning", "Retire through the integration"], { BRAIN_AS: "firstmate" });
  assert.equal(brain(["log", "retire", disposable.body.data.path], { BRAIN_AS: "firstmate" }).code, 0);
  const denied = brain(["log", "add", "interview", "Not mine"], { BRAIN_AS: "firstmate" });
  assert.equal(denied.code, 6);
  assert.equal(denied.body.error.code, "not_permitted");
  const interview = brain(["log", "add", "interview", "Brex screen"], { BRAIN_AS: "interview-coach" });
  assert.equal(interview.code, 0);
  assert.equal(brain(["log", "retire", interview.body.data.path], { BRAIN_AS: "firstmate" }).code, 3, "out-of-scope entries stay hidden");

  const fmLog = brain(["log"], { BRAIN_AS: "firstmate" });
  assert.deepEqual(fmLog.body.data.entries.map((e: { title: string }) => e.title), ["Crew lesson"]);
  assert.equal(brain(["view", "interview"], { BRAIN_AS: "firstmate" }).code, 6);
});

test("the primer names the integration, and an unknown BRAIN_AS is a config error", () => {
  const ctx = brain(["context"], { BRAIN_AS: "firstmate" });
  assert.match(ctx.body.data.context, /connected as the `firstmate` integration/);
  assert.doesNotMatch(ctx.body.data.context, /Brex screen/);
  const bad = brain(["search", "x"], { BRAIN_AS: "nope" });
  assert.equal(bad.code, 1);
  assert.equal(bad.body.error.code, "config");
  assert.match(bad.body.error.message, /known: interview-coach, firstmate, everything/);
});

test("sync mode none refreshes and exports without git; integration views export with their header", () => {
  const r = brain(["sync"]);
  assert.equal(r.code, 0);
  assert.equal(r.body.data.mode, "none");
  const learnings = readFileSync(join(root, "fm/data/learnings.md"), "utf8");
  assert.match(learnings, /^<!-- stow -->\n/);
  assert.match(learnings, /- Crew lesson\n/);
});

test("sync command mode runs the user's command in the vault", () => {
  const cfg = join(root, "cmd.json");
  writeFileSync(cfg, JSON.stringify({ sync: { command: 'echo "$BRAIN_MACHINE" > synced-by.txt' } }));
  const r = brain(["sync"], { BRAIN_CONFIG: cfg });
  assert.equal(r.code, 0);
  assert.equal(r.body.data.mode, "command");
  assert.equal(readFileSync(join(vault, "synced-by.txt"), "utf8").trim(), "mini");
});

test("iCloud placeholders: an evicted note stays searchable, get explains, doctor warns", () => {
  write("Career HQ/evicted.md", "# Evicted\nzebrafish\n");
  assert.equal(brain(["search", "zebrafish"]).body.data.results.length, 1);
  rmSync(join(vault, "Career HQ/evicted.md"));
  writeFileSync(join(vault, "Career HQ/.evicted.md.icloud"), "bplist");

  const s = brain(["search", "zebrafish"]);
  assert.equal(s.body.data.results.length, 1, "still found from the index");
  assert.equal(s.body.index.offline, 1);
  const g = brain(["get", "Career HQ/evicted"]);
  assert.equal(g.body.error.code, "offline");
  assert.match(g.body.error.message, /brctl download/);
  const d = brain(["doctor"]);
  assert.ok(d.body.data.checks.some((c: { check: string; status: string }) => c.check === "offline notes" && c.status === "warn"));
});

test("doctor warns when the vault is a git repository inside an iCloud folder", () => {
  const icloud = join(root, "Library", "Mobile Documents", "iCloud~md~obsidian", "Documents", "Vault");
  mkdirSync(join(icloud, ".obsidian"), { recursive: true });
  spawnSync("git", ["init", "-q", icloud]);
  const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, "doctor", "--json"], {
    env: { ...process.env, BRAIN_VAULT: icloud, BRAIN_CONFIG: join(root, "none.json"), BRAIN_MACHINE: "mini", BRAIN_AS: "" },
    encoding: "utf8",
  });
  const checks = JSON.parse(r.stdout).data.checks as { check: string; status: string; detail: string }[];
  const git = checks.find((c) => c.check === "git in a synced folder");
  assert.equal(git?.status, "warn");
  assert.match(git!.detail, /\.git\.nosync/);
  assert.equal(checks.find((c) => c.check === "index")?.status, "ok");
});
