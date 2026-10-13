// Immutable source files and their searchable markdown sidecars.
//
// Both files are created with `wx`. An ingest either creates a new pair or,
// when the same bytes are already present, returns the existing pair without
// writing anything.

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { slug, type Config } from "./config.js";
import { parseNote } from "./note.js";
import { brainPaths } from "./paths.js";

export const SOURCES_DIR = "sources";
export const SOURCE_SIDECAR_SUFFIX = ".source.md";

export interface IngestResult {
  path: string;
  id: string;
  new: boolean;
}

export interface IngestInput {
  file: string;
  title?: string;
  tags?: string[];
  now?: Date;
}

export function ingest(vault: string, cfg: Config, input: IngestInput): IngestResult {
  const origin = resolve(input.file);
  const inputFd = openSync(origin, "r");
  try {
    if (!fstatSync(inputFd).isFile()) throw new Error(`${origin} is not a regular file`);
    const id = hashFd(inputFd);
    const dir = brainPaths(vault, cfg.logDir).sources;
    const existing = findExisting(dir, id);
    if (existing) return { path: existing, id, new: false };

    const original = basename(origin);
    const rawTitle = input.title === undefined ? original.slice(0, original.length - extname(original).length) || original : input.title;
    const title = rawTitle.replace(/\s+/g, " ").trim();
    if (!title) throw new Error("a source needs a title");
    const extension = safeExtension(original);
    const ingested = (input.now ?? new Date()).toISOString();
    const stem = `${ingested.slice(0, 10)}-${cfg.machine}-${slug(title) || "source"}`;
    const tags = [...new Set((input.tags ?? []).map((t) => t.replace(/^#/, "").trim().toLowerCase()).filter(Boolean))];
    mkdirSync(dir, { recursive: true });

    for (let n = 1; ; n++) {
      const name = `${stem}${n === 1 ? "" : `-${n}`}${extension}`;
      const sourceAbs = join(dir, name);
      const sidecarAbs = sourceAbs + SOURCE_SIDECAR_SUFFIX;
      if (existsSync(sourceAbs) || existsSync(sidecarAbs)) continue;

      let sourceFd: number | null = null;
      let sidecarFd: number | null = null;
      let sourceCreated = false;
      let sidecarCreated = false;
      try {
        sourceFd = openSync(sourceAbs, "wx");
        sourceCreated = true;
        sidecarFd = openSync(sidecarAbs, "wx");
        sidecarCreated = true;
        const copiedHash = copyAndHash(inputFd, sourceFd);
        if (copiedHash !== id) throw new Error(`${origin} changed while it was being ingested; try again`);
        writeFileSync(sidecarFd, sidecar(title, ingested, cfg.machine, origin, id, tags));
        closeSync(sourceFd);
        sourceFd = null;
        closeSync(sidecarFd);
        sidecarFd = null;
        return { path: `${SOURCES_DIR}/${name}`, id, new: true };
      } catch (err) {
        if (sourceFd !== null) closeSync(sourceFd);
        if (sidecarFd !== null) closeSync(sidecarFd);
        // Roll back only files whose exclusive creates succeeded in this call.
        // Existing sources are never removed or replaced.
        if (sidecarCreated) rmSync(sidecarAbs, { force: true });
        if (sourceCreated) rmSync(sourceAbs, { force: true });
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
    }
  } finally {
    closeSync(inputFd);
  }
}

// Vault-relative paths of every `.source.md` sidecar under sources/. A file
// there is an ingested original only when its sidecar exists; anything else
// was written by hand and stays an ordinary note.
export function sourceSidecars(vault: string): string[] {
  const found: string[] = [];
  const visit = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) visit(join(dir, e.name), `${rel}/${e.name}`);
      else if (e.isFile() && e.name.endsWith(SOURCE_SIDECAR_SUFFIX)) found.push(`${rel}/${e.name}`);
    }
  };
  visit(join(vault, SOURCES_DIR), SOURCES_DIR);
  return found.sort();
}

function findExisting(dir: string, id: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(SOURCE_SIDECAR_SUFFIX)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  for (const name of names) {
    const sidecarAbs = join(dir, name);
    let metadata;
    try {
      metadata = parseNote(`${SOURCES_DIR}/${name}`, readFileSync(sidecarAbs, "utf8")).frontmatter;
    } catch {
      continue;
    }
    if (metadata.sha256 !== id) continue;
    const sourceName = name.slice(0, -SOURCE_SIDECAR_SUFFIX.length);
    const sourceAbs = join(dir, sourceName);
    if (!existsSync(sourceAbs) || hashPath(sourceAbs) !== id) continue;
    return `${SOURCES_DIR}/${sourceName}`;
  }
  return null;
}

function sidecar(title: string, ingested: string, machine: string, origin: string, id: string, tags: string[]): string {
  return [
    "---",
    `title: ${JSON.stringify(title)}`,
    `ingested: ${JSON.stringify(ingested)}`,
    `machine: ${JSON.stringify(machine)}`,
    `origin: ${JSON.stringify(origin)}`,
    `sha256: ${JSON.stringify(id)}`,
    `tags: [${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
    "---",
    "",
  ].join("\n");
}

function safeExtension(file: string): string {
  const ext = extname(file);
  return /^\.[A-Za-z0-9]{1,16}$/.test(ext) ? ext.toLowerCase() : "";
}

function hashPath(path: string): string {
  const fd = openSync(path, "r");
  try {
    return hashFd(fd);
  } finally {
    closeSync(fd);
  }
}

function hashFd(fd: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (let offset = 0; ; ) {
    const bytes = readSync(fd, buffer, 0, buffer.length, offset);
    if (!bytes) break;
    hash.update(buffer.subarray(0, bytes));
    offset += bytes;
  }
  return hash.digest("hex");
}

function copyAndHash(from: number, to: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (let offset = 0; ; ) {
    const bytes = readSync(from, buffer, 0, buffer.length, offset);
    if (!bytes) break;
    hash.update(buffer.subarray(0, bytes));
    let written = 0;
    while (written < bytes) written += writeSync(to, buffer, written, bytes - written);
    offset += bytes;
  }
  return hash.digest("hex");
}
