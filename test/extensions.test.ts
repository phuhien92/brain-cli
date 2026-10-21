import "./isolate.js";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { extensionBrainProcess, extensionProcess, resolveLauncher, type ExtensionManifest, type HookEvent } from "../src/extensions.js";
import { contextHookLines } from "../src/hooks.js";

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
function interactiveInstall(f: Fixture, source: string, answer = "y", extra: Record<string, string> = {}) {
  if (process.platform === "win32") throw new Error("pseudo-terminal helper is Unix-only");
  const command = [process.execPath, "--no-warnings=ExperimentalWarning", BIN, "ext", "install", source].map(quote).join(" ");
  const script = process.platform === "darwin"
    ? `script -q -e /dev/null ${command}`
    : `script -q -e -c ${quote(command)} /dev/null`;
  const pipeline = `(sleep 0.1; printf ${quote(`${answer}\n`)}; sleep 0.2) | ${script}`;
  const result = spawnSync("/bin/sh", ["-c", pipeline], { cwd: f.vault, env: environment(f, extra), encoding: "utf8" });
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
    permissions: { read: ["Allowed/"], write: ["event"], network: ["api.example.test"], environment: ["BRAIN_TEST_ALLOWED"] },
  }, `process.stdout.write(JSON.stringify({schema:"brain.v1",command:"${name}",ok:true,data:{args:process.argv.slice(2),vault:process.env.BRAIN_VAULT,as:process.env.BRAIN_AS,machine:process.env.BRAIN_MACHINE,dir:process.env.BRAIN_EXT_DIR,allowed:process.env.BRAIN_TEST_ALLOWED??null,secret:process.env.AWS_SECRET_ACCESS_KEY??null}})+"\\n")`);
}

function enabledHook(
  f: Fixture,
  name: string,
  permissions: ExtensionManifest["permissions"],
  hooks: Partial<Record<HookEvent, string>>,
  runtime: "node" | "sh" = "node",
): void {
  const directory = join(f.extensions, name);
  mkdirSync(join(directory, "bin"), { recursive: true });
  writeFileSync(join(directory, "brain-extension.json"), JSON.stringify({
    name, version: "1.0.0", command: "bin/command.mjs", hooks: Object.fromEntries(Object.keys(hooks).map((event) => [event, `bin/${event}.mjs`])), permissions,
  }));
  for (const [event, program] of Object.entries(hooks)) {
    const path = join(directory, "bin", `${event}.mjs`);
    writeFileSync(path, `${runtime === "sh" ? "#!/bin/sh" : "#!/usr/bin/env node"}\n${program}\n`);
    chmodSync(path, 0o755);
  }
  const command = join(directory, "bin", "command.mjs");
  writeFileSync(command, `#!/usr/bin/env node\nprocess.stdout.write('{"schema":"brain.v1","command":"${name}","ok":true,"data":{}}\\n')\n`);
  chmodSync(command, 0o755);
  mkdirSync(join(f.vault, "log", "extensions"), { recursive: true });
  writeFileSync(join(f.vault, "log", "extensions", `${name}.md`), `---\nkind: extension\nextension: ${JSON.stringify(name)}\n---\n# ${name}\n`);
}

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100 && !existsSync(path); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(existsSync(path), `timed out waiting for ${path}`);
}

test("context.build aggregates ordered lines while a broken hook is isolated", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const response = `printf '%s\\n' '{"schema":"brain.hook.v1","event":"context.build","ok":true,"data":{"lines":["first hook","second hook"]}}'`;
  enabledHook(f, "a-healthy", { read: [], write: [], network: [] }, { "context.build": response }, "sh");
  enabledHook(f, "b-broken", { read: [], write: [], network: [] }, { "context.build": response }, "sh");
  chmodSync(join(f.extensions, "b-broken", "bin", "context.build.mjs"), 0o644);

  const keys = ["BRAIN_EXTENSIONS_DIR", "BRAIN_STATE_DIR", "BRAIN_CONFIG", "BRAIN_MACHINE"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    BRAIN_EXTENSIONS_DIR: f.extensions,
    BRAIN_STATE_DIR: f.state,
    BRAIN_CONFIG: f.config,
    BRAIN_MACHINE: "test-machine",
  });
  try {
    assert.deepEqual(await contextHookLines(f.vault, loadConfig(f.vault), 2_000), ["first hook", "second hook"]);
  } finally {
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  }
});

for (const [name, program] of [["malformed", `printf 'not json\\n'`], ["failed", "exit 9"], ["slow", "sleep 2"]] as const) {
  test(`context.build keeps the primer when a hook is ${name}`, { skip: process.platform === "win32" }, (t) => {
    const f = fixture(t);
    enabledHook(f, `hook-${name}`, { read: [], write: [], network: [] }, { "context.build": program }, "sh");
    const started = Date.now();
    const result = brain(f, ["context"]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(Date.now() - started < 1200, "context hooks have a hard 300 ms budget");
    assert.match(result.stdout, /The user's notes and long-term memory/);
    assert.match(result.stdout, /<\/brain>/);
    assert.match(readFileSync(join(f.state, readdirSync(f.state)[0]!, "hooks.log"), "utf8"), new RegExp(`context\\.build hook-${name}`));
  });
}

test("log.added is post-write, scoped, detached from success, and reports failures", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const marker = join(f.root, "received.json");
  const skipped = join(f.root, "out-of-scope");
  enabledHook(f, "a-recorder", { read: [], write: ["learning"], network: [], environment: ["HOOK_MARKER"] }, {
    "log.added": `let input="";for await(const chunk of process.stdin)input+=chunk;const message=JSON.parse(input);const fs=await import("node:fs");if(!fs.existsSync(process.env.BRAIN_VAULT+"/"+message.data.entry.path))process.exit(8);fs.writeFileSync(process.env.HOOK_MARKER,JSON.stringify(message));process.stdout.write(JSON.stringify({schema:"brain.hook.v1",event:"log.added",ok:true,data:{}})+"\\n")`,
  });
  enabledHook(f, "b-out-of-scope", { read: ["Private/"], write: [], network: [] }, {
    "log.added": `const fs=await import("node:fs");fs.writeFileSync(${JSON.stringify(skipped)},"ran")`,
  });
  enabledHook(f, "c-failed", { read: [], write: ["learning"], network: [] }, { "log.added": `process.exit(7)` });

  const result = json(f, ["log", "add", "learning", "Hook payload", "--body", "safe body"], { HOOK_MARKER: marker });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.body.ok, true);
  assert.ok(existsSync(join(f.vault, ...result.body.data.path.split("/"))), "entry exists before detached hooks run");
  await waitFor(marker);
  const message = JSON.parse(readFileSync(marker, "utf8"));
  assert.deepEqual(message, {
    schema: "brain.hook.v1",
    event: "log.added",
    data: { entry: { path: result.body.data.path, kind: "learning", title: "Hook payload", body: "safe body", tags: [], machine: "test-machine" } },
  });
  assert.equal(existsSync(skipped), false, "a hook cannot receive an entry outside its declared scope");
  const diagnostics = join(f.state, readdirSync(f.state)[0]!, "hooks.log");
  await waitFor(diagnostics);
  assert.match(readFileSync(diagnostics, "utf8"), /log\.added c-failed: exited 7/);
});

async function waitForLines(path: string, count: number): Promise<string[]> {
  const read = () => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
  for (let attempt = 0; attempt < 150 && read().length < count; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(read().length, count, `timed out waiting for ${count} lines in ${path}`);
  return read();
}

test("log.added fires once for each entry created by add, import, and replace", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const marker = join(f.root, "events.txt");
  enabledHook(f, "recorder", { read: [], write: ["learning"], network: [], environment: ["HOOK_MARKER"] }, {
    "log.added": `let input="";for await(const chunk of process.stdin)input+=chunk;const {entry}=JSON.parse(input).data;const fs=await import("node:fs");fs.appendFileSync(process.env.HOOK_MARKER,JSON.stringify([entry.path,entry.title,entry.body])+"\\n");process.stdout.write(JSON.stringify({schema:"brain.hook.v1",event:"log.added",ok:true,data:{}})+"\\n")`,
  });
  const file = join(f.root, "import.md");
  writeFileSync(file, "- First imported\n- Second imported\n  with body\n");

  const imported = json(f, ["log", "import", "learning", file], { HOOK_MARKER: marker });
  assert.equal(imported.code, 0, imported.stderr);
  assert.equal(imported.body.data.added.length, 2);
  const afterImport = (await waitForLines(marker, 2)).map((line) => JSON.parse(line));
  assert.deepEqual(afterImport.map(([path]) => path).sort(), [...imported.body.data.added].sort());
  assert.deepEqual(afterImport.map(([, title, body]) => [title, body]).sort(), [["First imported", ""], ["Second imported", "with body"]]);

  const replaced = json(f, ["log", "replace", imported.body.data.added[0], "--text", "Replacement", "--body", "new body"], { HOOK_MARKER: marker });
  assert.equal(replaced.code, 0, replaced.stderr);
  const afterReplace = await waitForLines(marker, 3);
  assert.deepEqual(JSON.parse(afterReplace[2]!), [replaced.body.data.replacement, "Replacement", "new body"]);
});

test("hooks from an extension's own write keep the initiating caller scope and do not re-trigger", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const marker = join(f.root, "observed.txt");
  writeFileSync(join(f.vault, "brain.json"), JSON.stringify({ integrations: { caller: { read: ["Notes/"], write: ["learning"] } } }));
  enabledHook(f, "a-writer", { read: [], write: ["learning"], network: [], environment: ["HOOK_MARKER"] }, {});
  writeFileSync(join(f.extensions, "a-writer", "bin", "command.mjs"), `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const r=spawnSync(process.env.BRAIN_BIN,[...JSON.parse(process.env.BRAIN_BIN_ARGS_JSON??"[]"),"log","add","learning","From extension","--json"],{encoding:"utf8"});
const child=JSON.parse(r.stdout);
process.stdout.write(JSON.stringify({schema:"brain.v1",command:"a-writer",ok:child.ok,data:child.data,error:child.error})+"\\n");process.exitCode=r.status;
`);
  enabledHook(f, "b-observer", { read: [], write: ["learning"], network: [], environment: ["HOOK_MARKER"] }, {
    "log.added": `import { spawnSync } from "node:child_process";let input="";for await(const chunk of process.stdin)input+=chunk;const {entry}=JSON.parse(input).data;const prefix=JSON.parse(process.env.BRAIN_BIN_ARGS_JSON??"[]");const listed=spawnSync(process.env.BRAIN_BIN,[...prefix,"log","5","--json"],{encoding:"utf8"});const echoed=spawnSync(process.env.BRAIN_BIN,[...prefix,"log","add","learning","Echo of "+entry.title,"--json"],{encoding:"utf8"});const fs=await import("node:fs");fs.appendFileSync(process.env.HOOK_MARKER,JSON.stringify({as:process.env.BRAIN_AS,listed:listed.status,echoed:echoed.status,title:entry.title})+"\\n");process.stdout.write(JSON.stringify({schema:"brain.hook.v1",event:"log.added",ok:true,data:{}})+"\\n")`,
  });

  const written = json(f, ["a-writer"], { BRAIN_AS: "caller", HOOK_MARKER: marker });
  assert.equal(written.code, 0, written.stderr);
  assert.equal(written.body.ok, true);
  const [observed] = await waitForLines(marker, 1);
  assert.deepEqual(JSON.parse(observed!), { as: "caller", listed: 0, echoed: 0, title: "From extension" });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(readFileSync(marker, "utf8").split("\n").filter(Boolean).length, 1, "a hook's own write does not dispatch another hook");
  const titles = json(f, ["log", "10"], { BRAIN_AS: "caller" }).body.data.entries.map((entry: { title: string }) => entry.title).sort();
  assert.deepEqual(titles, ["Echo of From extension", "From extension"]);
});

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
  assert.match(installed.stdout + installed.stderr, /BRAIN_TEST_ALLOWED/);
  assert.equal(readdirSync(f.vault).includes("brain.json"), false, "enabling an extension does not create mutable vault config");
  assert.match(readFileSync(join(f.vault, "log", "extensions", "echoer.md"), "utf8"), /extension: "echoer"/);

  const bare = json(f, ["ext"]);
  assert.equal(bare.code, 2);
  assert.equal(bare.body.error.code, "usage");

  const markerPath = "log/extensions/echoer.md";
  assert.equal(json(f, ["search", "echoer"]).body.data.results.length, 0);
  assert.equal(json(f, ["get", markerPath]).code, 3);
  assert.equal(json(f, ["log", "10"]).body.data.entries.length, 0);
  assert.equal(json(f, ["view", "extension"]).body.data.entries, 0);
  assert.equal(json(f, ["log", "retire", markerPath]).code, 3);
  assert.equal(json(f, ["log", "replace", markerPath, "--text", "replacement"]).code, 3);

  const listed = json(f, ["ext", "list"]);
  assert.equal(listed.code, 0);
  const record = listed.body.data.extensions[0];
  assert.equal(record.name, "echoer");
  assert.equal(record.enabled, true);
  assert.deepEqual(record.manifest.permissions, { read: ["Allowed/"], write: ["event"], network: ["api.example.test"], environment: ["BRAIN_TEST_ALLOWED"] });

  const invoked = json(f, ["echoer", "hello"], { BRAIN_TEST_ALLOWED: "declared-value", AWS_SECRET_ACCESS_KEY: "ambient-secret" });
  assert.equal(invoked.code, 0);
  assert.equal(invoked.stdout.trim().split("\n").length, 1);
  assert.equal(invoked.body.schema, "brain.v1");
  assert.equal(invoked.body.data.as, "echoer");
  assert.equal(invoked.body.data.machine, "test-machine");
  assert.equal(invoked.body.data.vault, realpathSync(f.vault));
  assert.match(invoked.body.data.dir, /extensions\/echoer$/);
  assert.equal(invoked.body.data.allowed, "declared-value");
  assert.equal(invoked.body.data.secret, null);
  assert.deepEqual(invoked.body.data.args, ["hello", "--json"]);

  const leadingJson = brain(f, ["--json", "echoer", "leading"]);
  assert.equal(leadingJson.code, 0, leadingJson.stderr);
  assert.deepEqual(JSON.parse(leadingJson.stdout).data.args, ["leading", "--json"]);
  const leadingVault = json(f, ["--vault", f.vault, "echoer", "vault-first"]);
  assert.equal(leadingVault.code, 0, leadingVault.stderr);
  assert.deepEqual(leadingVault.body.data.args, ["vault-first", "--json"]);
  const quietJson = brain(f, ["echoer", "--json", "--quiet"]);
  assert.equal(quietJson.code, 0, quietJson.stderr);
  assert.equal(quietJson.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(quietJson.stdout).schema, "brain.v1");
  const quiet = brain(f, ["echoer", "--quiet"]);
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.equal(quiet.stdout, "");

  const secondVault = join(f.root, "second-vault");
  mkdirSync(join(secondVault, ".obsidian"), { recursive: true });
  writeFileSync(join(secondVault, "brain.json"), '{\n  "log": { "dir": "memory" }\n}\n');
  const second = { ...f, vault: secondVault };
  const enabledAgain = interactiveInstall(second, source);
  assert.equal(enabledAgain.code, 0, enabledAgain.stdout + enabledAgain.stderr);
  assert.equal(readFileSync(join(secondVault, "brain.json"), "utf8"), '{\n  "log": { "dir": "memory" }\n}\n');
  assert.match(readFileSync(join(secondVault, "memory", "extensions", "echoer.md"), "utf8"), /extension: "echoer"/);
  assert.equal(json(second, ["search", "echoer"]).body.data.results.length, 0, "custom log directories hide enablement markers too");
  assert.equal(json(second, ["echoer"]).code, 0, "one machine installation can be enabled independently in another vault");

  const reclassifiedVault = join(f.root, "reclassified-vault");
  mkdirSync(join(reclassifiedVault, ".obsidian"), { recursive: true });
  mkdirSync(join(reclassifiedVault, "memory", "extensions"), { recursive: true });
  writeFileSync(join(reclassifiedVault, "memory", "extensions", "echoer.md"), "---\nkind: extension\nextension: echoer\n---\n# Echoer\n");
  const reclassified = { ...f, vault: reclassifiedVault };
  assert.equal(json(reclassified, ["search", "echoer"]).body.data.results.length, 1);
  writeFileSync(join(reclassifiedVault, "brain.json"), '{\n  "log": { "dir": "memory" }\n}\n');
  assert.equal(json(reclassified, ["search", "echoer"]).body.data.results.length, 0, "changing log.dir reclassifies unchanged enablement markers");
  assert.equal(json(reclassified, ["get", "memory/extensions/echoer.md"]).code, 3);

  const collisionVault = join(f.root, "collision-vault");
  mkdirSync(join(collisionVault, ".obsidian"), { recursive: true });
  mkdirSync(join(collisionVault, "log", "extensions"), { recursive: true });
  const collisionPath = join(collisionVault, "log", "extensions", "echoer.md");
  const collisionContent = "---\nkind: observation\n---\n# Echoer notes\n";
  writeFileSync(collisionPath, collisionContent);
  const collision = { ...f, vault: collisionVault };
  assert.equal(json(collision, ["get", "log/extensions/echoer.md"]).code, 0, "an unrelated note in the marker directory remains visible");
  assert.equal(json(collision, ["echoer"]).code, 3, "an unrelated slug-named note cannot enable an extension");
  const conflicted = interactiveInstall(collision, source);
  assert.equal(conflicted.code, 5, conflicted.stdout + conflicted.stderr);
  assert.match(conflicted.stdout + conflicted.stderr, /not its enablement marker/);
  assert.equal(readFileSync(collisionPath, "utf8"), collisionContent);

  writeFileSync(join(source, "bin", "command.mjs"), "throw new Error('source changed')\n");
  const changed = interactiveInstall(f, source);
  assert.equal(changed.code, 5, changed.stdout + changed.stderr);
  assert.match(changed.stdout + changed.stderr, /different code or manifest/);
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

  for (const [name, environment] of [
    ["invalid-environment", ["BAD=NAME"]],
    ["reserved-environment", ["brain_extension_scope"]],
  ] as const) {
    const source = makeExtension(join(f.root, name), {
      name,
      command: "bin/command.mjs",
      permissions: { read: [], write: [], network: [], environment: [...environment] },
    }, "");
    const result = interactiveInstall(f, source);
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /environment permission/);
  }

  const builtIn = makeExtension(join(f.root, "ingest"), {
    name: "ingest",
    command: "bin/command.mjs",
    permissions: { read: [], write: [], network: [] },
  }, "");
  const reserved = interactiveInstall(f, builtIn);
  assert.equal(reserved.code, 2, reserved.stdout + reserved.stderr);
  assert.match(reserved.stdout + reserved.stderr, /'ingest' is a built-in command/);

  const alias = interactiveInstall(f, "github:example/brain-example");
  assert.equal(alias.code, 3, alias.stdout + alias.stderr);
  assert.match(alias.stdout + alias.stderr, /not a directory or git URL/);

  const credentialFailure = interactiveInstall(f, "HTTPS://user:secret-token@127.0.0.1:1/private.git?access_token=query-secret#fragment");
  assert.equal(credentialFailure.code, 1, credentialFailure.stdout + credentialFailure.stderr);
  assert.ok(!(credentialFailure.stdout + credentialFailure.stderr).includes("secret-token"));
  assert.ok(!(credentialFailure.stdout + credentialFailure.stderr).includes("query-secret"));
  assert.match(credentialFailure.stdout + credentialFailure.stderr, /https:\/\/127\.0\.0\.1:1\/private\.git/);
  const lastError = readFileSync(join(f.state, "last-error.json"), "utf8");
  assert.ok(!lastError.includes("secret-token"));
  assert.ok(!lastError.includes("query-secret"));
  assert.ok(!lastError.includes("fragment"));
  assert.match(lastError, /https:\/\/127\.0\.0\.1:1\/private\.git/);

  const linked = echoExtension(join(f.root, "linked-source"), "linked");
  const externalHelper = join(f.root, "external-helper.mjs");
  writeFileSync(externalHelper, "export const value = 1;\n");
  symlinkSync(externalHelper, join(linked, "bin", "helper.mjs"));
  const linkedInstall = interactiveInstall(f, linked);
  assert.equal(linkedInstall.code, 2, linkedInstall.stdout + linkedInstall.stderr);
  assert.match(linkedInstall.stdout + linkedInstall.stderr, /cannot be a symlink/);
  assert.equal(existsSync(join(f.extensions, "linked")), false);
});

test("scalar-like extension names round-trip through enablement and provenance", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  for (const name of ["true", "001"]) {
    const sourceId = createHash("sha256").update(name).digest("hex");
    const source = makeExtension(join(f.root, `${name}-source`), {
      name,
      command: "bin/command.mjs",
      permissions: { read: [], write: ["event"], network: [] },
    }, `
import { spawnSync } from "node:child_process";
const prefix=JSON.parse(process.env.BRAIN_BIN_ARGS_JSON??"[]");
const result=spawnSync(process.env.BRAIN_BIN,[...prefix,"log","add","event","from ${name}","--source-id","${sourceId}","--source-created","2026-10-13T00:00:00.000Z","--json"],{env:process.env,encoding:"utf8"});
process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode=result.status;
`);
    assert.equal(interactiveInstall(f, source).code, 0);
    const invoked = json(f, [name]);
    assert.equal(invoked.code, 0, invoked.stderr || invoked.stdout);
  }
  const entries = json(f, ["log", "10", "--kind", "event"]);
  assert.deepEqual(new Set(entries.body.data.entries.map((entry: { machine: string }) => entry.machine)), new Set(["true", "001"]));
});

test("extension manifest versions follow SemVer 2", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const valid = makeExtension(join(f.root, "valid-version"), {
    name: "valid-version",
    version: "1.2.3-alpha.1+build.5",
    command: "bin/command.mjs",
    permissions: { read: [], write: [], network: [] },
  }, `process.stdout.write(JSON.stringify({schema:"brain.v1",command:"valid-version",ok:true,data:{}})+"\\n")`);
  assert.equal(interactiveInstall(f, valid).code, 0);
  assert.equal(json(f, ["ext", "list"]).body.data.extensions[0].manifest.version, "1.2.3-alpha.1+build.5");

  const invalid = makeExtension(join(f.root, "invalid-version"), {
    name: "invalid-version",
    version: "1.2.3-alpha.01",
    command: "bin/command.mjs",
    permissions: { read: [], write: [], network: [] },
  }, "");
  const rejected = interactiveInstall(f, invalid);
  assert.equal(rejected.code, 2, rejected.stdout + rejected.stderr);
  assert.match(rejected.stdout + rejected.stderr, /version must be semver/);
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

  const credentialSource = "https://user:secret-token@example.invalid/private.git?access_token=query-secret";
  const installed = interactiveInstall(f, credentialSource, "y", {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${pathToFileURL(source).href}.insteadOf`,
    GIT_CONFIG_VALUE_0: credentialSource,
  });
  assert.equal(installed.code, 0, installed.stdout + installed.stderr);
  const listed = json(f, ["ext", "list"]).body.data.extensions[0];
  assert.equal(listed.commit, commit);
  assert.equal(listed.source, "https://example.invalid/private.git");
  assert.ok(!JSON.stringify(listed).includes("secret-token"));
  const metadata = JSON.parse(readFileSync(join(listed.directory, ".brain-install.json"), "utf8"));
  assert.equal(metadata.source, "https://example.invalid/private.git");
  writeFileSync(join(listed.directory, ".brain-install.json"), JSON.stringify({ ...metadata, source: "deploy-token@example.invalid:private.git" }));
  assert.equal(json(f, ["ext", "list"]).body.data.extensions[0].source, "example.invalid:private.git");
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

test("built-ins win and a broken extension is isolated", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.vault, "notes"));
  writeFileSync(join(f.vault, "notes", "answer.md"), "# Answer\nneedle built-in proof\n");
  const brokenSource = makeExtension(join(f.root, "broken-source"), {
    name: "broken",
    command: "bin/command.mjs",
    permissions: { read: [], write: [], network: [] },
  }, `
import { spawn } from "node:child_process";
const action = process.argv[2];
if (action === "hang") setInterval(() => {}, 1000);
else if (action === "flood") {
  process.stdout.write("x".repeat(2 * 1024 * 1024));
  setInterval(() => {}, 1000);
} else if (action === "descendant-flood") {
  spawn(process.execPath, ["-e", "setTimeout(()=>require('fs').writeFileSync(process.argv[1], 'survived'), 500)", process.argv[3]], { stdio: "ignore" });
  process.stdout.write("x".repeat(2 * 1024 * 1024));
  setInterval(() => {}, 1000);
} else if (action === "bad-error") {
  process.stdout.write(JSON.stringify({ schema: "brain.v1", command: "broken", ok: false, error: {} }) + "\\n");
  process.exitCode = 1;
} else if (action === "success-with-error") {
  process.stdout.write(JSON.stringify({ schema: "brain.v1", command: "broken", ok: true, data: {}, error: { code: "wrong", message: "wrong" } }) + "\\n");
} else if (action === "failure-with-data") {
  process.stdout.write(JSON.stringify({ schema: "brain.v1", command: "broken", ok: false, data: {}, error: { code: "failed", message: "failed" } }) + "\\n");
  process.exitCode = 1;
} else if (action === "private-error") {
  process.stdout.write(JSON.stringify({ schema: "brain.v1", command: "broken", ok: false, error: { code: "customer_acme_private", message: "local detail" } }) + "\\n");
  process.exitCode = 1;
} else process.stdout.write("not json\\nextra line\\n");`);
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

  const flooded = json(f, ["broken", "flood"]);
  assert.equal(flooded.code, 1);
  assert.equal(flooded.body.error.code, "extension_output_limit");
  assert.match(flooded.body.error.message, /1 MiB/);

  const sideEffect = join(f.root, "descendant-side-effect");
  const descendant = json(f, ["broken", "descendant-flood", sideEffect]);
  assert.equal(descendant.code, 1);
  assert.equal(descendant.body.error.code, "extension_output_limit");
  await new Promise((done) => setTimeout(done, 800));
  assert.equal(existsSync(sideEffect), false, "limit termination must kill extension descendants before delayed work runs");

  const badError = json(f, ["broken", "bad-error"]);
  assert.equal(badError.code, 1);
  assert.equal(badError.body.error.code, "extension_protocol");
  for (const action of ["success-with-error", "failure-with-data"]) {
    const ambiguous = json(f, ["broken", action]);
    assert.equal(ambiguous.code, 1);
    assert.equal(ambiguous.body.error.code, "extension_protocol");
  }

  const privateError = json(f, ["broken", "private-error"], { BRAIN_TELEMETRY: "1" });
  assert.equal(privateError.code, 1);
  assert.equal(privateError.body.error.code, "customer_acme_private", "the local extension envelope stays unchanged");
  const events = readFileSync(join(f.state, "telemetry-queue.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).error, "extension_failed");
  assert.ok(!JSON.stringify(events).includes("customer_acme_private"));

  const quietFailure = brain(f, ["broken", "private-error", "--quiet"]);
  assert.equal(quietFailure.code, 1);
  assert.equal(quietFailure.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(quietFailure.stdout).error.code, "customer_acme_private");

  const hung = json(f, ["broken", "hang"]);
  assert.equal(hung.code, 1);
  assert.equal(hung.body.error.code, "extension_timeout");
  assert.match(hung.body.error.message, /30 second/);
  assert.equal(json(f, ["index"]).code, 0, "a broken extension cannot break built-ins");
  assert.equal(json(f, ["context"]).code, 0, "context keeps its never-fail contract");
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
const childEnv={...process.env};
const brainPrefix=JSON.parse(process.env.BRAIN_BIN_ARGS_JSON??"[]");
if(action==="tamper") {
  delete childEnv.BRAIN_EXTENSION_SCOPE;
  delete childEnv.BRAIN_EXTENSION_PARENT_AS;
  delete childEnv.BRAIN_EXT_REDACT;
  childEnv.BRAIN_AS="";
  childEnv.BRAIN_VAULT="/does-not-exist";
  childEnv.BRAIN_CONFIG="/does-not-exist";
  childEnv.BRAIN_EXTENSIONS_DIR="/does-not-exist";
}
if(action==="write-allowed"||action==="write-denied") {
  const kind=action==="write-allowed"?"event":"secret";
  const r=spawnSync(process.env.BRAIN_BIN,[...brainPrefix,"log","add",kind,"extension write","--json"],{env:childEnv,encoding:"utf8"});
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode=r.status;
} else {
  const r=spawnSync(process.env.BRAIN_BIN,[...brainPrefix,"search","shared-word","--json"],{env:childEnv,encoding:"utf8"});
  const child=JSON.parse(r.stdout);
  process.stdout.write(JSON.stringify({schema:"brain.v1",command:"probe",ok:true,data:{as:process.env.BRAIN_AS,paths:child.data.results.map(x=>x.path)}})+"\\n");
}`);
  assert.equal(interactiveInstall(f, source).code, 0);

  const own = json(f, ["probe"]);
  assert.deepEqual(own.body.data.paths, ["Allowed/visible.md"]);
  assert.equal(own.body.data.as, "probe");
  assert.deepEqual(json(f, ["probe", "tamper"]).body.data.paths, ["Allowed/visible.md"], "the scoped launcher restores deleted identity");
  assert.equal(json(f, ["probe", "write-allowed"]).code, 0);
  const denied = json(f, ["probe", "write-denied"]);
  assert.equal(denied.code, 6);
  assert.equal(denied.body.error.code, "not_permitted");

  const narrowed = json(f, ["probe", "tamper", "--as", "narrow"]);
  assert.deepEqual(narrowed.body.data.paths, [], "Allowed ∩ Private is empty; extension permission cannot widen the caller");
  assert.equal(narrowed.body.data.as, "narrow", "the parent scope is delivered through BRAIN_AS");

  const adminSource = makeExtension(join(f.root, "admin-source"), {
    name: "admin-probe",
    command: "bin/command.mjs",
    permissions: { read: [], write: [], network: [] },
  }, `
import { spawnSync } from "node:child_process";
const command=JSON.parse(Buffer.from(process.argv[2],"base64url").toString("utf8"));
const args=command.includes("--json")?command:[...command,"--json"];
const brainPrefix=JSON.parse(process.env.BRAIN_BIN_ARGS_JSON??"[]");
const childEnv={...process.env,BRAIN_AS:""};
delete childEnv.BRAIN_EXTENSION_SCOPE;
delete childEnv.BRAIN_EXTENSION_PARENT_AS;
delete childEnv.BRAIN_EXT_REDACT;
childEnv.BRAIN_CONFIG="/does-not-exist";
childEnv.BRAIN_EXTENSIONS_DIR="/does-not-exist";
const r=spawnSync(process.env.BRAIN_BIN,[...brainPrefix,...args],{env:childEnv,encoding:"utf8"});
process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode=r.status;
`);
  assert.equal(interactiveInstall(f, adminSource).code, 0);
  const deniedCommands = [
    ["setup"],
    ["telemetry", "show"],
    ["feedback", "list"],
    ["ext", "remove", "admin-probe"],
    ["agent", "install", "claude", "--dry-run"],
    ["index"],
    ["export"],
    ["sync"],
    ["integrations"],
    ["doctor"],
    ["lint"],
    ["path"],
    ["probe"],
    ["context"],
    ["log", "add", "event", "forbidden"],
    ["log", "import", "event", "secrets.md"],
    ["log", "retire", "event-id"],
    ["log", "replace", "event-id", "--text", "replacement"],
    ["lifecycle", "set", "Allowed/visible.md"],
    ["lifecycle", "review", "Allowed/visible.md"],
    ["lifecycle", "archive", "Allowed/visible.md"],
    ["lifecycle", "restore", "Allowed/visible.md"],
  ];
  for (const command of deniedCommands) {
    const encoded = Buffer.from(JSON.stringify(command)).toString("base64url");
    const deniedChild = json(f, ["admin-probe", encoded]);
    assert.equal(deniedChild.code, 6, `${command.join(" ")} must be denied`);
    assert.equal(deniedChild.body.error.code, "not_permitted");
  }
  const doubleDash = json(f, ["admin-probe", Buffer.from(JSON.stringify(["--json", "--", "telemetry", "show"])).toString("base64url")]);
  assert.equal(doubleDash.code, 6);
  assert.equal(doubleDash.body.error.code, "not_permitted");
  assert.equal(json(f, ["admin-probe", Buffer.from(JSON.stringify(["search", "shared-word"])).toString("base64url")]).code, 0);
  assert.equal(json(f, ["admin-probe", Buffer.from(JSON.stringify(["lifecycle", "status"])).toString("base64url")]).code, 0);

  const redactionSource = makeExtension(join(f.root, "redaction-source"), {
    name: "redaction-probe",
    command: "bin/command.mjs",
    permissions: { read: [], write: ["event"], network: [] },
  }, `
import { spawnSync } from "node:child_process";
const token=process.env.BRAIN_EXT_REDACT_TOKEN;
const brainPrefix=JSON.parse(process.env.BRAIN_BIN_ARGS_JSON??"[]");
const encoded=Buffer.from("private@example.com").toString("base64url");
const nestedUrl=Buffer.from("https://app.example/meetings/alice%2540example.com").toString("base64url");
const unsafeOriginUrl=Buffer.from("https://tenant-99887766.example/meetings/public").toString("base64url");
const body="<!-- brain-protected:"+token+":"+encoded+" -->\\n<!-- brain-protected-url:"+token+":"+nestedUrl+" -->\\n<!-- brain-protected-url:"+token+":"+unsafeOriginUrl+" -->";
const childEnv={...process.env,BRAIN_AS:""};
delete childEnv.BRAIN_EXTENSION_SCOPE;
delete childEnv.BRAIN_EXTENSION_PARENT_AS;
delete childEnv.BRAIN_EXT_REDACT;
delete childEnv.BRAIN_EXT_REDACT_TOKEN;
const r=spawnSync(process.env.BRAIN_BIN,[...brainPrefix,"log","add","event","redaction probe","--tag","private@example.com","--tag","1234567","--body","-","--json"],{env:childEnv,encoding:"utf8",input:body});
process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode=r.status;
`);
  assert.equal(interactiveInstall(f, redactionSource).code, 0);
  const redacted = json(f, ["redaction-probe"]);
  assert.equal(redacted.code, 0, redacted.stderr || redacted.stdout);
  const redactedNote = readFileSync(join(f.vault, ...redacted.body.data.path.split("/")), "utf8");
  assert.ok(!redactedNote.includes("private@example.com"), "extensions cannot protect arbitrary values from redaction");
  assert.ok(!redactedNote.includes("alice%2540example.com"), "nested URL encoding cannot bypass redaction");
  assert.ok(!redactedNote.includes("tenant-"), "sensitive origins are omitted instead of partially redacted");
  assert.match(redactedNote, /https:\/\/app\.example\//);
  assert.match(redactedNote, /tags: \[<email>, <number>\]/);
});

test("source IDs converge across machines and reject unrelated path collisions", (t) => {
  const first = fixture(t);
  const second = fixture(t);
  const sourceId = createHash("sha256").update("shared-source").digest("hex");
  const sourceCreated = "2026-10-13T02:00:00.000Z";
  const args = ["log", "add", "meeting", "Shared meeting", "--source-id", sourceId, "--source-created", sourceCreated, "--body", "Same source body"];
  const a = json(first, args, { BRAIN_MACHINE: "machine-a" });
  const b = json(second, args, { BRAIN_MACHINE: "machine-b" });
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(a.body.data.path, b.body.data.path);
  const aNote = readFileSync(join(first.vault, ...a.body.data.path.split("/")), "utf8");
  const bNote = readFileSync(join(second.vault, ...b.body.data.path.split("/")), "utf8");
  assert.equal(aNote, bNote, "the same source produces merge-identical records on every machine");
  assert.equal(a.body.data.machine, "source");
  assert.match(aNote, /created: 2026-10-13T02:00:00\.000Z/);
  assert.match(aNote, /machine: "source"/);
  const listed = json(first, ["log", "1", "--kind", "meeting"]);
  assert.equal(listed.body.data.entries[0].created, sourceCreated);
  assert.equal(listed.body.data.entries[0].machine, "source");

  const missingCreated = json(fixture(t), ["log", "add", "meeting", "Missing time", "--source-id", sourceId]);
  assert.equal(missingCreated.code, 2);
  assert.match(missingCreated.body.error.message, /must be used together/);
  const invalidCreated = json(fixture(t), ["log", "add", "meeting", "Invalid time", "--source-id", sourceId, "--source-created", "yesterday"]);
  assert.equal(invalidCreated.code, 2);
  assert.match(invalidCreated.body.error.message, /canonical ISO timestamp/);

  const collision = fixture(t);
  const collisionPath = join(collision.vault, ...a.body.data.path.split("/"));
  mkdirSync(dirname(collisionPath), { recursive: true });
  writeFileSync(collisionPath, "# Unrelated\n");
  const rejected = json(collision, args, { BRAIN_MACHINE: "machine-c" });
  assert.equal(rejected.code, 1);
  assert.match(rejected.body.error.message, /occupied by a different entry/);
  assert.equal(readFileSync(collisionPath, "utf8"), "# Unrelated\n");
});

test("meetings imports redacted summaries and links from a fake server, never transcripts, and deduplicates source IDs", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.vault, "Alice.md"), "# Alice\n");
  assert.equal(interactiveInstall(f, MEETINGS).code, 0);
  let requested = "";
  const firstSourceId = "granola-source-secret-id";
  const secondSourceId = "another-granola-source-secret-id";
  const poisonedMarker = createHash("sha256").update(secondSourceId).digest("hex");
  const payload: { meetings: Array<Record<string, unknown>> } = {
    meetings: [{
      id: firstSourceId,
      title: "Weekly planning",
      date: "2026-10-13T09:00:00.123456-07:00",
      attendees: ["Alice <alice@example.com>", "Bob"],
      summary: `Reset link https://internal.example/reset?email=private@example.com&id=7654321 with literal brain-extension-url-0 and <!-- brain-source-marker-0 --> plus <!-- brain-source-id: ${poisonedMarker} -->.`,
      actionItems: ["Bob sends the plan to alice@example.com"],
      url: "https://app.granola.example/meetings/planning?email=source-secret@example.com&token=99887766#private-source",
      transcript: "NEVER-SYNC-THIS-TRANSCRIPT",
    }],
  };
  let responsePayload: unknown = payload;
  const server = createServer((req, res) => {
    requested = req.url ?? "";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(responsePayload));
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
  assert.match(files[0]!, new RegExp(`-${createHash("sha256").update(firstSourceId).digest("hex")}\\.md$`));
  const note = readFileSync(join(meetingDir, files[0]!), "utf8");
  assert.match(note, /Weekly planning/);
  assert.match(note, /2026-10-13/);
  assert.match(note, /created: 2026-10-13T16:00:00\.123Z/);
  assert.match(note, /machine: "meetings"/);
  assert.match(note, /email=<email>&id=<number>/);
  assert.match(note, /literal brain-extension-url-0 and <!-- brain-source-marker-0 -->/);
  assert.match(note, /<email>/);
  assert.match(note, /\[Open in the meeting source\]\(https:\/\/app\.granola\.example\/meetings\/planning\)/);
  assert.match(note, /source-id: "[0-9a-f]{64}"/);
  for (const forbidden of ["NEVER-SYNC-THIS-TRANSCRIPT", "alice@example.com", "private@example.com", "source-secret@example.com", "7654321", "99887766", "private-source", "granola-source-secret-id"]) {
    assert.ok(!note.includes(forbidden), `meeting note must not contain ${forbidden}`);
  }
  assert.equal((note.match(/source-id: "[0-9a-f]{64}"/g) ?? []).length, 1);

  renameSync(join(meetingDir, files[0]!), join(meetingDir, "renamed-first.md"));
  const renamedRepeat = await invoke();
  assert.equal(renamedRepeat.code, 0, renamedRepeat.stderr);
  assert.equal(JSON.parse(renamedRepeat.stdout).data.skipped, 1, "source identity survives a user rename");
  assert.equal(readdirSync(meetingDir).length, 1);

  payload.meetings[0]!.id = secondSourceId;
  payload.meetings[0]!.url = "https://app.granola.example/meetings/alice%40example.com/reset-token-99887766";
  const second = await invoke();
  assert.equal(second.code, 0, second.stderr);
  const secondBody = JSON.parse(second.stdout);
  assert.equal(secondBody.data.added.length, 1);
  assert.equal(secondBody.data.skipped, 0);
  const sensitivePathNote = readFileSync(join(f.vault, ...secondBody.data.added[0].split("/")), "utf8");
  assert.match(sensitivePathNote, /\[Open in the meeting source\]\(https:\/\/app\.granola\.example\/\)/);
  assert.ok(!sensitivePathNote.includes("alice%40example.com"));
  assert.ok(!sensitivePathNote.includes("99887766"));
  const notes = readdirSync(meetingDir).map((file) => readFileSync(join(meetingDir, file), "utf8"));
  assert.equal(notes.length, 2);
  for (const recurring of notes) {
    assert.match(recurring, /Weekly planning/);
    assert.match(recurring, /Alice <<email>>/);
    assert.ok(!recurring.includes("<note-"), "vault note titles must not be redacted from imported content");
  }

  const archived = json(f, ["lifecycle", "archive", secondBody.data.added[0], "--reason", "idempotency check"]);
  assert.equal(archived.code, 0, archived.stderr);
  const third = await invoke();
  assert.equal(third.code, 0, third.stderr);
  const thirdBody = JSON.parse(third.stdout);
  assert.equal(thirdBody.data.added.length, 0);
  assert.equal(thirdBody.data.skipped, 1);
  assert.equal(readdirSync(meetingDir).length, 2);

  responsePayload = payload.meetings;
  const undocumentedArray = await invoke();
  assert.equal(undocumentedArray.code, 1);
  assert.equal(JSON.parse(undocumentedArray.stdout).error.code, "source_failed");

  const valid = {
    id: "validation-source",
    title: "Validation meeting",
    date: "2026-10-14",
    attendees: ["Alice"],
    summary: "Valid summary",
    actionItems: ["Valid action"],
    url: "https://app.granola.example/meetings/validation",
  };
  const invalidFields: Array<[string, unknown]> = [
    ["id", null],
    ["title", {}],
    ["date", {}],
    ["date", "2026-02-31"],
    ["date", "2026-02-31T09:00:00Z"],
    ["date", "2026-10-13T24:00:00Z"],
    ["attendees", [{}]],
    ["attendees", ["Alice\u001b[2J"]],
    ["summary", {}],
    ["summary", "unsafe\u001b[2J"],
    ["actionItems", [{}]],
    ["actionItems", ["unsafe\u001b[2J"]],
    ["title", "unsafe\u001b[2J"],
    ["url", {}],
    ["url", "not a URL"],
  ];
  for (const [field, value] of invalidFields) {
    responsePayload = { meetings: [{ ...valid, [field]: value }] };
    const invalid = await invoke();
    assert.equal(invalid.code, 1);
    assert.equal(JSON.parse(invalid.stdout).error.code, "source_failed");
    assert.equal(readdirSync(meetingDir).length, 2, `${field} validation must happen before any note is written`);
  }

  responsePayload = { meetings: [{ ...valid, id: "concurrent-source" }] };
  const concurrent = await Promise.all([invoke(), invoke()]);
  for (const result of concurrent) assert.equal(result.code, 0, result.stderr || result.stdout);
  const concurrentBodies = concurrent.map((result) => JSON.parse(result.stdout));
  assert.equal(concurrentBodies.reduce((sum, body) => sum + body.data.added.length, 0), 1);
  assert.equal(concurrentBodies.reduce((sum, body) => sum + body.data.skipped, 0), 1);
  assert.equal(readdirSync(meetingDir).length, 3, "concurrent imports create one source entry");
});

test("Windows launcher convention resolves extension commands and scoped brain child calls", (t) => {
  const f = fixture(t);
  const directory = join(f.root, "windows %TEMP% extension");
  mkdirSync(join(directory, "bin"), { recursive: true });
  const manifest: ExtensionManifest = {
    name: "windows-test",
    version: "1.0.0",
    command: "bin/run",
    permissions: { read: [], write: [], network: [] },
  };
  writeFileSync(
    join(directory, "bin", "run.cmd"),
    '@echo off\r\nnode -e "require(\'fs\').writeFileSync(process.argv[1], process.env.BRAIN_EXTENSION_ARGS_JSON)" "%~dp0result.json"\r\n',
  );
  const cmd = resolveLauncher(directory, manifest, "win32");
  assert.equal(cmd, join(directory, "bin", "run.cmd"));
  const forwarded = ["an argument", 'a" & echo injected & "b', "%PATH%", "^&|<>"];
  const launch = extensionProcess(cmd, forwarded, "win32");
  assert.match(launch.file.toLowerCase(), /cmd\.exe$/);
  assert.deepEqual(launch.args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
  assert.equal(launch.args[4], `""%BRAIN_EXTENSION_LAUNCHER%""`);
  assert.equal(launch.env?.BRAIN_EXTENSION_LAUNCHER, cmd);
  assert.deepEqual(JSON.parse(launch.env?.BRAIN_EXTENSION_ARGS_JSON ?? "null"), forwarded);
  assert.ok(!launch.args.join(" ").includes("injected"));
  if (process.platform === "win32") {
    const result = spawnSync(launch.file, launch.args, { env: { ...process.env, ...launch.env }, windowsVerbatimArguments: true });
    assert.equal(result.status, 0, result.stderr?.toString());
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "bin", "result.json"), "utf8")), forwarded);
  }

  const runner = join(directory, "scoped-runner.mjs");
  writeFileSync(runner, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n');
  const brainLaunch = extensionBrainProcess(runner);
  assert.equal(brainLaunch.file, process.execPath);
  assert.deepEqual(brainLaunch.args, ["--no-warnings=ExperimentalWarning", runner]);
  const brainResult = spawnSync(brainLaunch.file, [...brainLaunch.args, ...forwarded], { encoding: "utf8" });
  assert.equal(brainResult.status, 0, brainResult.stderr);
  assert.deepEqual(JSON.parse(brainResult.stdout), forwarded);

  writeFileSync(join(directory, "bin", "run.exe"), "fixture");
  assert.equal(resolveLauncher(directory, manifest, "win32"), join(directory, "bin", "run.exe"));
});
