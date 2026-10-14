// The update check: what it asks, when it speaks, and that it can never get in
// a command's way. Every request goes to a local fake GitHub.
import "./isolate.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/cli.js";
import { highestTag, isNewer, notice, parseVersion, updateFile } from "../src/update.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(ROOT, "bin/brain.js");
let root: string;
let vault: string;
let server: Server;
let base: string;
let url: string;
let round = 0;
let requests: { userAgent: string | undefined; url: string | undefined }[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: [] };

function env(extra: Record<string, string> = {}) {
  const e: Record<string, string> = {
    ...(process.env as Record<string, string>),
    BRAIN_VAULT: vault,
    BRAIN_STATE_DIR: join(root, "state"),
    BRAIN_CONFIG: join(root, "config.json"),
    BRAIN_UPDATE_URL: url,
    BRAIN_NO_UPDATE_CHECK: "",
    BRAIN_AS: "",
    ...extra,
  };
  if (!("CI" in extra)) delete e.CI;
  delete e.BRAIN_BACKGROUND;
  return e;
}
// Async on purpose: the fake GitHub runs in this process, so a blocking spawn
// would leave it unable to answer.
function brain(args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, ...args], { cwd: vault, env: env(extra) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}
const stateFile = () => join(root, "state", "update-check.json");
function seed(state: Record<string, unknown>) {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(state));
}
const newer = () => {
  const [a, b] = VERSION.split(".").map(Number);
  return `${a}.${b! + 1}.0`;
};
async function until(cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !cond()) await new Promise((r) => setTimeout(r, 50));
}

before(async () => {
  // Real path: on macOS the temp dir is /var/…, which brain reports as /private/var/….
  root = realpathSync(mkdtempSync(join(tmpdir(), "brain-update-")));
  vault = join(root, "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  server = createServer((req, res) => {
    // A background check left over from an earlier test asks with that test's
    // URL, so it can never be counted against this one.
    if (req.url === new URL(url).pathname) requests.push({ userAgent: req.headers["user-agent"], url: req.url });
    res.statusCode = answer.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  url = `${base}/tags/${++round}`;
  requests = [];
  answer = { status: 200, body: [] };
  rmSync(join(root, "state"), { recursive: true, force: true });
});

test("versions: only plain releases count, compared numerically", async () => {
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  assert.equal(parseVersion("1.2.3-rc.1"), null);
  assert.equal(parseVersion("latest"), null);
  assert.ok(isNewer("0.10.0", "0.9.9"));
  assert.ok(!isNewer("0.10.0", "0.10.0"));
  assert.ok(!isNewer("0.2.0", "0.10.0"));
  assert.equal(highestTag([{ name: "v0.9.0" }, { name: "v0.12.0" }, { name: "v0.10.3" }, { name: "v0.13.0-rc.1" }, { name: "nightly" }]), "0.12.0");
  assert.equal(highestTag({ message: "Not Found" }), null);
});

test("VERSION is package.json's version, and CHANGELOG.md has an entry for it", async () => {
  assert.equal(VERSION, JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
  assert.match(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), new RegExp(`^## ${VERSION.replace(/\./g, "\\.")} `, "m"));
});

test("brain update --check asks GitHub, sends only a user agent, and prints the pinned install command", async () => {
  answer.body = [{ name: "v0.1.0" }, { name: `v${newer()}` }];
  const r = await brain(["update", "--check", "--json"]);
  assert.equal(r.code, 0);
  const data = JSON.parse(r.stdout).data;
  assert.equal(data.latest, newer());
  assert.equal(data.available, true);
  assert.equal(data.command, `npm install -g github:phuhien92/brain-cli#v${newer()}`);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.userAgent, `brain-cli/${VERSION}`);
  assert.equal(requests[0]!.url, new URL(url).pathname);
});

test("a failed check fails nothing: exit 0, the error reported, the last answer kept", async () => {
  seed({ latest: newer(), checkedAt: 0, notifiedAt: 0 });
  answer = { status: 500, body: {} };
  const r = await brain(["update", "--check", "--json"]);
  assert.equal(r.code, 0);
  const data = JSON.parse(r.stdout).data;
  assert.match(data.error, /500/);
  assert.equal(data.latest, newer());
  const unreachable = await brain(["update", "--check", "--json"], { BRAIN_UPDATE_URL: "http://127.0.0.1:9/" });
  assert.equal(unreachable.code, 0);
  assert.ok(JSON.parse(unreachable.stdout).data.error);
});

test("once a day, after a command, the check runs in the background", async () => {
  answer.body = [{ name: `v${newer()}` }];
  const r = await brain(["path", "vault"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), vault);
  await until(() => requests.length > 0 && existsSync(stateFile()) && JSON.parse(readFileSync(stateFile(), "utf8")).latest !== null);
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(readFileSync(stateFile(), "utf8")).latest, newer());
  await brain(["path", "vault"]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(requests.length, 1, "checked at most once a day");
});

test("off means no request: BRAIN_NO_UPDATE_CHECK, the machine config, or CI", async () => {
  await brain(["path", "vault"], { BRAIN_NO_UPDATE_CHECK: "1" });
  writeFileSync(join(root, "config.json"), JSON.stringify({ updates: { check: false } }));
  await brain(["path", "vault"]);
  rmSync(join(root, "config.json"));
  await brain(["path", "vault"], { CI: "true" });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(requests.length, 0);
  assert.equal(existsSync(stateFile()), false);
  const st = JSON.parse((await brain(["update", "--json"], { BRAIN_NO_UPDATE_CHECK: "1" })).stdout).data;
  assert.equal(st.enabled, false);
  assert.match(st.reason, /BRAIN_NO_UPDATE_CHECK/);
});

test("scripts and agents never see the notice: stderr stays empty when it is not a terminal", async () => {
  seed({ latest: newer(), checkedAt: Date.now(), notifiedAt: 0 });
  for (const args of [["path", "vault"], ["path", "vault", "--json"], ["doctor"]]) {
    assert.equal((await brain(args)).stderr, "", args.join(" "));
  }
});

test("doctor tells an agent an update is available, with the command", async () => {
  seed({ latest: newer(), checkedAt: Date.now(), notifiedAt: 0 });
  const checks = JSON.parse((await brain(["doctor", "--json"])).stdout).data.checks as { check: string; status: string; detail: string }[];
  const up = checks.find((c) => c.check === "update")!;
  assert.equal(up.status, "warn");
  assert.match(up.detail, new RegExp(`brain ${newer().replace(/\./g, "\\.")} is available.*#v${newer().replace(/\./g, "\\.")}`));
});

test("the notice: a person at a terminal, at most once a day, never in --json, --quiet, CI, a hook, or when off", async () => {
  const saved = { ...process.env };
  process.env.BRAIN_STATE_DIR = join(root, "state");
  process.env.BRAIN_NO_UPDATE_CHECK = "";
  delete process.env.CI;
  delete process.env.BRAIN_BACKGROUND;
  try {
    const base = { version: VERSION, configCheck: null, json: false, quiet: false, command: "search", tty: true, now: Date.now() };
    seed({ latest: newer(), checkedAt: Date.now(), notifiedAt: 0 });
    assert.equal(notice({ ...base, tty: false }), null);
    assert.equal(notice({ ...base, json: true }), null);
    assert.equal(notice({ ...base, quiet: true }), null);
    assert.equal(notice({ ...base, command: "context" }), null);
    assert.equal(notice({ ...base, configCheck: false }), null);
    process.env.CI = "true";
    assert.equal(notice(base), null);
    delete process.env.CI;
    assert.equal(
      notice(base),
      `brain ${newer()} is available (you have ${VERSION}): npm install -g github:phuhien92/brain-cli#v${newer()}`,
    );
    assert.equal(notice(base), null, "once a day");
    assert.ok(notice({ ...base, now: base.now + 25 * 60 * 60 * 1000 }), "and again the next day");
    seed({ latest: VERSION, checkedAt: Date.now(), notifiedAt: 0 });
    assert.equal(notice(base), null, "nothing when current");
    assert.equal(updateFile(), stateFile());
  } finally {
    process.env = saved;
  }
});

test("setup --yes --update-check no records the choice in the machine config", async () => {
  const r = await brain(["setup", "--yes", "--vault", vault, "--agents", "", "--update-check", "no", "--json"], { HOME: root });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).updates.check, false);
  assert.equal((await brain(["setup", "--yes", "--vault", vault, "--update-check", "maybe"])).code, 2);
  rmSync(join(root, "config.json"));
});
