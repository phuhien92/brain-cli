import "./isolate.js";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";
import { extensionProcess, resolveLauncher, type ExtensionManifest } from "../src/extensions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "../../bin/brain.js");
const MEETINGS = resolve(HERE, "../../examples/meetings");

interface Fixture {
  root: string;
  vault: string;
  extensions: string;
  config: string;
  state: string;
}

function fixture(t: { after(fn: () => void): void }): Fixture {
  const root = mkdtempSync(join(tmpdir(), "brain-ext-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  const value = { root, vault, extensions: join(root, "extensions"), config: join(root, "config.json"), state: join(root, "state") };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return value;
}

function environment(f: Fixture, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BRAIN_VAULT: f.vault,
    BRAIN_CONFIG: f.config,
    BRAIN_STATE_DIR: f.state,
    BRAIN_EXTENSIONS_DIR: f.extensions,
    BRAIN_MACHINE: "test-machine",
    BRAIN_AS: "",
    BRAIN_TELEMETRY: "0",
    BRAIN_POSTHOG_KEY: "",
    ...extra,
  };
  delete env.CI;
  delete env.BRAIN_EXTENSION_SCOPE;
  delete env.BRAIN_EXTENSION_PARENT_AS;
  delete env.BRAIN_EXT_REDACT;
  return env;
}

function brain(f: Fixture, args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, ...args], {
    cwd: f.vault,
    env: environment(f, extra),
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function json(f: Fixture, args: string[], extra: Record<string, string> = {}) {
  const result = brain(f, [...args, "--json"], extra);
  return { ...result, body: JSON.parse(result.stdout) };
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// Install has no non-interactive approval switch. Tests exercise the actual
// terminal path through the operating system's `script` pseudo-terminal.
function interactiveInstall(f: Fixture, source: string, answer = "y") {
  if (process.platform === "win32") throw new Error("pseudo-terminal helper is Unix-only");
  const command = [process.execPath, "--no-warnings=ExperimentalWarning", BIN, "ext", "install", source].map(quote).join(" ");
  const script = process.platform === "darwin"
    ? `script -q -e /dev/null ${command}`
    : `script -q -e -c ${quote(command)} /dev/null`;
  const pipeline = `(sleep 0.1; printf ${quote(`${answer}\n`)}; sleep 0.2) | ${script}`;
  const result = spawnSync("/bin/sh", ["-c", pipeline], { cwd: f.vault, env: environment(f), encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function makeExtension(root: string, manifest: Omit<ExtensionManifest, "version"> & { version?: string }, program: string): string {
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "brain-extension.json"), JSON.stringify({ ...manifest, version: manifest.version ?? "1.0.0" }, null, 2) + "\n");
  const launcher = join(root, "bin", "command.mjs");
  writeFileSync(launcher, `#!/usr/bin/env node\n${program}\n`);
  chmodSync(launcher, 0o755);
  return root;
}

function echoExtension(path: string, name = "echoer"): string {
  return makeExtension(path, {
    name,
    command: "bin/command.mjs",
    description: "test extension",
    permissions: { read: ["Allowed/"], write: ["event"], network: ["api.example.test"] },
  }, `process.stdout.write(JSON.stringify({schema:"brain.v1",command:"${name}",ok:true,data:{args:process.argv.slice(2),vault:process.env.BRAIN_VAULT,as:process.env.BRAIN_AS,machine:process.env.BRAIN_MACHINE,dir:process.env.BRAIN_EXT_DIR}})+"\\n")`);
}

test("install needs human permission approval and exposes the declared permissions", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const source = echoExtension(join(f.root, "source"));

  const rejected = json(f, ["ext", "install", source]);
  assert.equal(rejected.code, 6);
  assert.equal(rejected.body.error.code, "permission_confirmation_required");
  assert.equal(readdirSync(f.root).includes("extensions"), false, "a non-interactive caller installs nothing");

  const cancelled = interactiveInstall(f, source, "n");
  assert.equal(cancelled.code, 0, cancelled.stdout + cancelled.stderr);
  assert.equal(readdirSync(f.extensions).length, 0, "declining the permission prompt installs nothing");
  assert.equal(readdirSync(f.vault).includes("brain.json"), false);

  const installed = interactiveInstall(f, source);
  assert.equal(installed.code, 0, installed.stdout + installed.stderr);
  assert.equal(readdirSync(f.vault).includes("brain.json"), false, "enabling an extension does not create mutable vault config");
  assert.match(readFileSync(join(f.vault, "log", "extensions", "echoer.md"), "utf8"), /extension: echoer/);

  const listed = json(f, ["ext", "list"]);
  assert.equal(listed.code, 0);
  const record = listed.body.data.extensions[0];
  assert.equal(record.name, "echoer");
  assert.equal(record.enabled, true);
  assert.deepEqual(record.manifest.permissions, { read: ["Allowed/"], write: ["event"], network: ["api.example.test"] });

  const invoked = json(f, ["echoer", "hello"]);
  assert.equal(invoked.code, 0);
  assert.equal(invoked.stdout.trim().split("\n").length, 1);
  assert.equal(invoked.body.schema, "brain.v1");
  assert.equal(invoked.body.data.as, "echoer");
  assert.equal(invoked.body.data.machine, "test-machine");
  assert.equal(invoked.body.data.vault, realpathSync(f.vault));
  assert.match(invoked.body.data.dir, /extensions\/echoer$/);
  assert.deepEqual(invoked.body.data.args, ["hello", "--json"]);

  const secondVault = join(f.root, "second-vault");
  mkdirSync(join(secondVault, ".obsidian"), { recursive: true });
  writeFileSync(join(secondVault, "brain.json"), '{\n  "log": { "dir": "memory" }\n}\n');
  const second = { ...f, vault: secondVault };
  const enabledAgain = interactiveInstall(second, source);
  assert.equal(enabledAgain.code, 0, enabledAgain.stdout + enabledAgain.stderr);
  assert.equal(readFileSync(join(secondVault, "brain.json"), "utf8"), '{\n  "log": { "dir": "memory" }\n}\n');
  assert.match(readFileSync(join(secondVault, "memory", "extensions", "echoer.md"), "utf8"), /extension: echoer/);
  assert.equal(json(second, ["echoer"]).code, 0, "one machine installation can be enabled independently in another vault");

  writeFileSync(join(source, "bin", "command.mjs"), "throw new Error('source changed')\n");
  assert.equal(json(f, ["echoer"]).code, 0, "local installs are copies, not mutable source links");
});

test("install rejects terminal controls in permission text and unsupported source aliases", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const unsafe: Array<[string, Omit<ExtensionManifest, "version">]> = [
    ["description", {
      name: "unsafe-description",
      command: "bin/command.mjs",
      description: "looks safe\u001b[2J",
      permissions: { read: [], write: [], network: [] },
    }],
    ["read path", {
      name: "unsafe-read",
      command: "bin/command.mjs",
      permissions: { read: ["Allowed/\u001b[2J"], write: [], network: [] },
    }],
  ];
  for (const [field, manifest] of unsafe) {
    const source = makeExtension(join(f.root, `unsafe-${field.replace(" ", "-")}`), manifest, "");
    const result = interactiveInstall(f, source);
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /control characters/);
  }

  const alias = interactiveInstall(f, "github:example/brain-example");
  assert.equal(alias.code, 3, alias.stdout + alias.stderr);
  assert.match(alias.stdout + alias.stderr, /not a directory or git URL/);
});

test("git installation records its commit, remove is machine-local, and missing installs fail cleanly", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const source = echoExtension(join(f.root, "git-source"), "from-git");
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", ["-C", source, "config", "user.email", "test@example.test"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Extension Test"]);
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-qm", "fixture"]);
  const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  const installed = interactiveInstall(f, pathToFileURL(source).href);
  assert.equal(installed.code, 0, installed.stdout + installed.stderr);
  const listed = json(f, ["ext", "list"]).body.data.extensions[0];
  assert.equal(listed.commit, commit);
  assert.equal(json(f, ["from-git"]).code, 0);

  const removed = json(f, ["ext", "remove", "from-git"]);
  assert.equal(removed.code, 0);
  assert.equal(removed.body.data.stillEnabled, true, "removing on one machine must not disable the synced vault for every machine");
  const after = json(f, ["ext", "list"]).body.data.extensions[0];
  assert.equal(after.installed, false);
  assert.equal(after.enabled, true);
  const missing = json(f, ["from-git"]);
  assert.equal(missing.code, 3);
  assert.equal(missing.body.error.code, "not_found");
});

test("built-ins win, BRAIN_NO_EXTENSIONS disables discovery, and a broken extension is isolated", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  mkdirSync(join(f.vault, "notes"));
  writeFileSync(join(f.vault, "notes", "answer.md"), "# Answer\nneedle built-in proof\n");
  const brokenSource = makeExtension(join(f.root, "broken-source"), {
    name: "broken",
    command: "bin/command.mjs",
    permissions: { read: [], write: [], network: [] },
  }, `process.stdout.write("not json\\nextra line\\n")`);
  assert.equal(interactiveInstall(f, brokenSource).code, 0);

  // Even an invalid, manually placed extension named search cannot shadow core.
  const searchDir = join(f.extensions, "search");
  mkdirSync(searchDir, { recursive: true });
  writeFileSync(join(searchDir, "brain-extension.json"), JSON.stringify({ name: "search", version: "1.0.0", command: "run", permissions: { read: [], write: [], network: [] } }));
  writeFileSync(join(searchDir, "run"), "#!/bin/sh\necho shadowed > ran\n");
  chmodSync(join(searchDir, "run"), 0o755);
  mkdirSync(join(f.vault, "log", "extensions"), { recursive: true });
  writeFileSync(join(f.vault, "log", "extensions", "search.md"), "# search\n");
  const builtIn = json(f, ["search", "needle"]);
  assert.equal(builtIn.code, 0);
  assert.equal(builtIn.body.command, "search");
  assert.equal(builtIn.body.data.results[0].path, "notes/answer.md");

  const broken = json(f, ["broken"]);
  assert.equal(broken.code, 1);
  assert.equal(broken.stdout.trim().split("\n").length, 1);
  assert.equal(broken.body.error.code, "extension_protocol");
  assert.equal(json(f, ["index"]).code, 0, "a broken extension cannot break built-ins");
  assert.equal(json(f, ["context"]).code, 0, "context keeps its never-fail contract");

  const disabled = json(f, ["broken"], { BRAIN_NO_EXTENSIONS: "1" });
  assert.equal(disabled.code, 2);
  assert.match(disabled.body.error.message, /disabled/);
});

test("extension scope is enforced and intersected with an existing BRAIN_AS scope", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  mkdirSync(join(f.vault, "Allowed"));
  mkdirSync(join(f.vault, "Private"));
  writeFileSync(join(f.vault, "Allowed", "visible.md"), "# Visible\nshared-word allowed\n");
  writeFileSync(join(f.vault, "Private", "hidden.md"), "# Hidden\nshared-word private\n");
  writeFileSync(join(f.vault, "brain.json"), JSON.stringify({ integrations: { narrow: { read: ["Private/"], write: [] } } }, null, 2));
  const source = makeExtension(join(f.root, "probe-source"), {
    name: "probe",
    command: "bin/command.mjs",
    permissions: { read: ["Allowed/"], write: ["event"], network: [] },
  }, `
import { spawnSync } from "node:child_process";
const action=process.argv[2];
if(action==="write-allowed"||action==="write-denied") {
  const kind=action==="write-allowed"?"event":"secret";
  const r=spawnSync(process.execPath,[process.env.BRAIN_BIN,"log","add",kind,"extension write","--json"],{env:process.env,encoding:"utf8"});
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode=r.status;
} else {
  const r=spawnSync(process.execPath,[process.env.BRAIN_BIN,"search","shared-word","--json"],{env:process.env,encoding:"utf8"});
  const child=JSON.parse(r.stdout);
  process.stdout.write(JSON.stringify({schema:"brain.v1",command:"probe",ok:true,data:{as:process.env.BRAIN_AS,paths:child.data.results.map(x=>x.path)}})+"\\n");
}`);
  assert.equal(interactiveInstall(f, source).code, 0);

  const own = json(f, ["probe"]);
  assert.deepEqual(own.body.data.paths, ["Allowed/visible.md"]);
  assert.equal(own.body.data.as, "probe");
  assert.equal(json(f, ["probe", "write-allowed"]).code, 0);
  const denied = json(f, ["probe", "write-denied"]);
  assert.equal(denied.code, 6);
  assert.equal(denied.body.error.code, "not_permitted");

  const narrowed = json(f, ["probe", "--as", "narrow"]);
  assert.deepEqual(narrowed.body.data.paths, [], "Allowed ∩ Private is empty; extension permission cannot widen the caller");
  assert.equal(narrowed.body.data.as, "narrow", "the parent scope is delivered through BRAIN_AS");
});

test("meetings imports redacted summaries and links from a fake server, never transcripts, and deduplicates source IDs", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.vault, "Alice.md"), "# Alice\n");
  assert.equal(interactiveInstall(f, MEETINGS).code, 0);
  let requested = "";
  const payload: { meetings: Array<Record<string, unknown>> } = {
    meetings: [{
      id: "granola-source-secret-id",
      title: "Weekly planning",
      date: "2026-10-13",
      attendees: ["Alice <alice@example.com>", "Bob"],
      summary: "Reviewed private account 1234567 and selected the launch plan.",
      actionItems: ["Bob sends the plan to alice@example.com"],
      url: "https://app.granola.example/meetings/1234567",
      transcript: "NEVER-SYNC-THIS-TRANSCRIPT",
    }],
  };
  const server = createServer((req, res) => {
    requested = req.url ?? "";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;

  const invoke = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, "meetings", "import", "--since", "7d", "--json"], {
      cwd: f.vault,
      env: environment(f, { BRAIN_MEETINGS_API_URL: `http://127.0.0.1:${port}/meetings` }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });

  const first = await invoke();
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout.trim().split("\n").length, 1);
  const firstBody = JSON.parse(first.stdout);
  assert.equal(firstBody.schema, "brain.v1");
  assert.equal(firstBody.data.added.length, 1);
  assert.equal(firstBody.data.skipped, 0);
  assert.match(requested, /since=7d/);

  const meetingDir = join(f.vault, "log", "meeting");
  const files = readdirSync(meetingDir);
  assert.equal(files.length, 1);
  const note = readFileSync(join(meetingDir, files[0]!), "utf8");
  assert.match(note, /Weekly planning/);
  assert.match(note, /2026-10-13/);
  assert.match(note, /Reviewed private account <number>/);
  assert.match(note, /<email>/);
  assert.match(note, /\[Open in the meeting source\]\(https:\/\/app\.granola\.example\/meetings\/1234567\)/);
  assert.match(note, /brain-source-id: [0-9a-f]{64}/);
  for (const forbidden of ["NEVER-SYNC-THIS-TRANSCRIPT", "alice@example.com", "granola-source-secret-id"]) {
    assert.ok(!note.includes(forbidden), `meeting note must not contain ${forbidden}`);
  }
  assert.equal((note.match(/1234567/g) ?? []).length, 1, "the private number is redacted, while the intentional source URL stays usable");

  payload.meetings[0]!.id = "another-granola-source-secret-id";
  const second = await invoke();
  assert.equal(second.code, 0, second.stderr);
  const secondBody = JSON.parse(second.stdout);
  assert.equal(secondBody.data.added.length, 1);
  assert.equal(secondBody.data.skipped, 0);
  const notes = readdirSync(meetingDir).map((file) => readFileSync(join(meetingDir, file), "utf8"));
  assert.equal(notes.length, 2);
  for (const recurring of notes) {
    assert.match(recurring, /Weekly planning/);
    assert.match(recurring, /Alice <<email>>/);
    assert.ok(!recurring.includes("<note-"), "vault note titles must not be redacted from imported content");
  }

  const third = await invoke();
  assert.equal(third.code, 0, third.stderr);
  const thirdBody = JSON.parse(third.stdout);
  assert.equal(thirdBody.data.added.length, 0);
  assert.equal(thirdBody.data.skipped, 1);
  assert.equal(readdirSync(meetingDir).length, 2);
});

test("Windows launcher convention resolves extensionless manifest commands to .exe then .cmd", (t) => {
  const f = fixture(t);
  const directory = join(f.root, "windows-extension");
  mkdirSync(join(directory, "bin"), { recursive: true });
  const manifest: ExtensionManifest = {
    name: "windows-test",
    version: "1.0.0",
    command: "bin/run",
    permissions: { read: [], write: [], network: [] },
  };
  writeFileSync(join(directory, "bin", "run.cmd"), "@echo off\r\n");
  const cmd = resolveLauncher(directory, manifest, "win32");
  assert.equal(cmd, join(directory, "bin", "run.cmd"));
  const process = extensionProcess(cmd, ["an argument", "& unsafe"], "win32");
  assert.match(process.file.toLowerCase(), /cmd\.exe$/);
  assert.deepEqual(process.args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
  assert.match(process.args[4]!, /\^&/);
  writeFileSync(join(directory, "bin", "run.exe"), "fixture");
  assert.equal(resolveLauncher(directory, manifest, "win32"), join(directory, "bin", "run.exe"));
});
