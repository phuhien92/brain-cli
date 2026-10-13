import "./isolate.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/config.js";
import { parseNote } from "../src/note.js";
import { ingest } from "../src/source.js";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/brain.js");
let root: string;
let vault: string;

function brain(args: string[]) {
  const result = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", BIN, ...args, "--json"], {
    cwd: vault,
    env: {
      ...process.env,
      BRAIN_VAULT: vault,
      BRAIN_CONFIG: join(root, "config.json"),
      BRAIN_MACHINE: "My Laptop",
      BRAIN_AS: "",
    },
    encoding: "utf8",
  });
  return { code: result.status, body: JSON.parse(result.stdout), stderr: result.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brain-ingest-"));
  vault = join(root, "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("ingest copies bytes with a machine-safe name and writes searchable metadata", () => {
  const input = join(root, "Paper FINAL.PDF");
  const bytes = Buffer.from([0, 255, 10, 42, 7]);
  writeFileSync(input, bytes);

  const result = brain(["ingest", input, "--title", 'Paper: \"A/B\"', "--tag", "Reading", "--tag", "review"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.body.schema, "brain.v1");
  assert.equal(result.body.command, "ingest");
  assert.equal(result.body.data.new, true);
  assert.match(result.body.data.path, /^sources\/\d{4}-\d{2}-\d{2}-my-laptop-paper-a-b\.pdf$/);
  assert.deepEqual(Object.keys(result.body.data).sort(), ["id", "new", "path"]);
  assert.equal(result.body.data.id, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(readFileSync(join(vault, result.body.data.path)), bytes);

  const sidecarPath = result.body.data.path + ".source.md";
  const sidecar = readFileSync(join(vault, sidecarPath), "utf8");
  const note = parseNote(sidecarPath, sidecar);
  assert.equal(note.frontmatter.title, 'Paper: "A/B"');
  assert.match(String(note.frontmatter.ingested), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(note.frontmatter.machine, "my-laptop");
  assert.equal(note.frontmatter.origin, input);
  assert.equal(note.frontmatter.sha256, result.body.data.id);
  assert.deepEqual(note.frontmatter.tags, ["reading", "review"]);
  assert.equal(result.body.index.added, 1, "only the sidecar is indexed");

  const search = brain(["search", "paper"]);
  assert.deepEqual(search.body.data.results.map((hit: { path: string }) => hit.path), [sidecarPath]);
});

test("same sha256 is idempotent and writes nothing on the second ingest", () => {
  const firstInput = join(root, "first.txt");
  const secondInput = join(root, "renamed.txt");
  writeFileSync(firstInput, "same bytes\n");
  writeFileSync(secondInput, "same bytes\n");
  const first = brain(["ingest", firstInput, "--title", "First"]);
  assert.equal(first.code, 0);
  const beforeNames = readdirSync(join(vault, "sources")).sort();
  const beforeMtime = statSync(join(vault, first.body.data.path + ".source.md")).mtimeMs;

  const second = brain(["ingest", secondInput, "--title", "Different title"]);
  assert.equal(second.code, 0);
  assert.equal(second.body.data.new, false);
  assert.equal(second.body.data.path, first.body.data.path);
  assert.equal(second.body.data.id, first.body.data.id);
  assert.deepEqual(readdirSync(join(vault, "sources")).sort(), beforeNames);
  assert.equal(statSync(join(vault, first.body.data.path + ".source.md")).mtimeMs, beforeMtime);
});

test("exclusive creates never replace a colliding source pair", () => {
  const input = join(root, "report.pdf");
  writeFileSync(input, "new bytes");
  const day = new Date().toISOString().slice(0, 10);
  const occupied = join(vault, "sources", `${day}-my-laptop-report.pdf`);
  mkdirSync(dirname(occupied), { recursive: true });
  writeFileSync(occupied, "keep source");
  writeFileSync(occupied + ".source.md", "keep sidecar");

  const result = brain(["ingest", input, "--title", "Report"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.body.data.path, /-report-2\.pdf$/);
  assert.equal(readFileSync(occupied, "utf8"), "keep source");
  assert.equal(readFileSync(occupied + ".source.md", "utf8"), "keep sidecar");
});

test("a failure after exclusive creation rolls back only the incomplete pair", () => {
  const input = join(root, "atomic.txt");
  writeFileSync(input, "atomic bytes\n");
  let machineReads = 0;
  const cfg: Config = {
    logDir: "log",
    get machine() {
      machineReads++;
      if (machineReads > 1) throw new Error("injected sidecar failure");
      return "mini";
    },
    exports: [],
    sync: "none",
    integrations: {},
    as: null,
    lifecycleWindows: {},
    lintMaxLines: {},
    lintUnsourced: [],
    userConfigPath: "",
  };
  assert.throws(() => ingest(vault, cfg, { file: input, now: new Date("2026-10-13T00:00:00Z") }), /injected sidecar failure/);
  assert.deepEqual(readdirSync(join(vault, "sources")), []);
});

test("a failed preflight leaves sources untouched", () => {
  const directory = join(root, "not-a-file");
  mkdirSync(directory);
  const result = brain(["ingest", directory]);
  assert.equal(result.code, 1);
  assert.equal(result.body.ok, false);
  assert.equal(existsSync(join(vault, "sources")), false);
});
