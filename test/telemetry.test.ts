import "./isolate.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { telemetryName } from "../src/cli.js";
import { parseAnswer, shouldAsk } from "../src/telemetry.js";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/brain.js");
let root: string;
let vault: string;
let state: string;

function env(extra: Record<string, string> = {}) {
  const e: Record<string, string> = { ...(process.env as Record<string, string>), BRAIN_VAULT: vault, BRAIN_CONFIG: join(root, "config.json"), BRAIN_STATE_DIR: state, BRAIN_MACHINE: "mini", BRAIN_AS: "", ...extra };
  delete e.DO_NOT_TRACK;
  delete e.BRAIN_TELEMETRY;
  delete e.BRAIN_TELEMETRY_URL;
  return { ...e, ...extra };
}
function brain(args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, ...args], { cwd: vault, env: env(extra), encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const shown = (extra: Record<string, string> = {}) => JSON.parse(brain(["telemetry", "show", "--json"], extra).stdout).data;

before(() => {
  root = mkdtempSync(join(tmpdir(), "brain-tel-"));
  vault = join(root, "Private Vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  mkdirSync(join(vault, "Finance"));
  writeFileSync(join(vault, "Finance/severance.md"), "# Severance package\nSecret figures.\n");
});
beforeEach(() => {
  state = mkdtempSync(join(root, "state-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

test("off by default: nothing is recorded, and nobody is asked without a terminal", () => {
  const r = brain(["search", "secret severance figures", "--json"]);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "", "no question, no notice: an agent's output is untouched");
  const st = shown();
  assert.equal(st.enabled, false);
  assert.match(st.reason, /off by default/);
  assert.equal(st.events.length, 0);
});

test("the one-time question: only for a person at a terminal who has not decided", () => {
  const base = { json: false, command: "search", userConfigTelemetry: null, tty: true };
  process.env.BRAIN_STATE_DIR = state;
  const saved = { DO_NOT_TRACK: process.env.DO_NOT_TRACK, BRAIN_TELEMETRY: process.env.BRAIN_TELEMETRY, CI: process.env.CI };
  delete process.env.DO_NOT_TRACK;
  delete process.env.BRAIN_TELEMETRY;
  delete process.env.CI;
  try {
    assert.equal(shouldAsk(base), true);
    assert.equal(shouldAsk({ ...base, tty: false }), false, "agents and scripts: never");
    assert.equal(shouldAsk({ ...base, json: true }), false);
    assert.equal(shouldAsk({ ...base, command: "context" }), false, "never inside a session hook");
    assert.equal(shouldAsk({ ...base, userConfigTelemetry: false }), false, "already decided in config");
    process.env.CI = "true";
    assert.equal(shouldAsk(base), false, "never in CI");
    delete process.env.CI;
    brain(["telemetry", "disable"]);
    assert.equal(shouldAsk(base), false, "asked once, never again");
  } finally {
    Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)));
  }
  assert.equal(parseAnswer("y"), true);
  assert.equal(parseAnswer(" Yes "), true);
  assert.equal(parseAnswer(""), false, "no answer is no");
  assert.equal(parseAnswer("sure"), false);
});

test("opted in: an event holds only the documented fields and nothing typed or stored by the user", () => {
  brain(["telemetry", "enable"]);
  const r = brain(["search", "secret severance figures", "--json"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim().split("\n").length, 1, "stdout stays one JSON line");

  const { enabled, events } = shown();
  assert.equal(enabled, true);
  const e = events[0];
  assert.deepEqual(Object.keys(e).sort(), ["command", "day", "error", "exit", "install", "integrations", "json", "ms", "node", "notes", "os", "schema", "scoped", "sync", "version"]);
  assert.equal(e.command, "search");
  assert.equal(e.notes, "<100");
  const all = JSON.stringify(events);
  for (const secret of ["secret", "severance", "Severance", "Finance", "Private Vault", vault, hostname(), "mini"]) {
    assert.ok(!all.includes(secret), `telemetry must not contain ${secret}`);
  }
});

test("free text never becomes a command name", () => {
  assert.equal(telemetryName("feedback", "hello"), "feedback");
  assert.equal(telemetryName("log", "add"), "log.add");
  assert.equal(telemetryName("my-private-word", undefined), "unknown");
});

test("errors are recorded by code only", () => {
  brain(["telemetry", "enable"]);
  brain(["get", "Finance/severance-plan", "--json"]);
  const e = shown().events.at(-1);
  assert.equal(e.error, "not_found");
  assert.ok(!JSON.stringify(e).includes("severance"));
});

test("every switch works: DO_NOT_TRACK beats an opt-in; BRAIN_TELEMETRY; disable; user config", () => {
  brain(["telemetry", "enable"]);
  brain(["index"], { DO_NOT_TRACK: "1" });
  brain(["index"], { BRAIN_TELEMETRY: "0" });
  assert.equal(shown({ DO_NOT_TRACK: "1" }).events.length, 0);
  assert.equal(shown({ DO_NOT_TRACK: "1" }).enabled, false);

  brain(["telemetry", "disable"]);
  brain(["index"]);
  assert.equal(shown().events.length, 0);
  assert.match(shown().reason, /opted out/);
  brain(["telemetry", "enable"]);

  writeFileSync(join(root, "config.json"), JSON.stringify({ telemetry: false }));
  brain(["index"]);
  assert.equal(shown().enabled, false);
  rmSync(join(root, "config.json"));

  brain(["telemetry", "disable"]);
  assert.equal(shown({ BRAIN_TELEMETRY: "1" }).enabled, true, "BRAIN_TELEMETRY=1 opts in without asking");
});

test("flush posts the queue to the collector and clears it; no collector means nothing leaves", async () => {
  brain(["telemetry", "enable"]);
  brain(["index"]);
  brain(["search", "x"]);
  const noCollector = JSON.parse(brain(["telemetry", "flush", "--json"]).stdout).data;
  assert.equal(noCollector.sent, 0);
  assert.match(noCollector.error, /no collector/);

  let received: { schema: string; events: unknown[] } | null = null;
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      received = JSON.parse(b);
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const out = await new Promise<string>((done) => {
    const p = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, "telemetry", "flush", "--json"], {
      cwd: vault,
      env: env({ BRAIN_TELEMETRY_URL: `http://127.0.0.1:${port}/v1` }),
    });
    let s = "";
    p.stdout.on("data", (c) => (s += c));
    p.on("close", () => done(s));
  });
  server.close();
  assert.equal(JSON.parse(out).data.sent, 2);
  assert.equal(received!.schema, "brain.telemetry.v1");
  assert.equal(received!.events.length, 2);
  assert.equal(shown().events.length, 0, "queue cleared after a successful send");
});
