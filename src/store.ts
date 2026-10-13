// The index: a SQLite file at <vault>/.brain/index.db, never committed.
//
// Freshness model (borrowed from Serena): one full pass up front, then every
// command calls refresh() first. refresh() stats every note and re-parses only
// those whose (mtime, size) changed — and of those, only the ones whose content
// hash changed. Deleted notes are dropped. There is no watcher and no daemon:
// the index is never stale at the moment it is read, and costs a stat() per
// note to keep that way.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { basename, parseNote, type Frontmatter, type Link } from "./note.js";

const SCHEMA_VERSION = 1;

// Folders that are never notes. Dot-folders (.git, .obsidian, .trash, .brain)
// are skipped wholesale.
const SKIP_DIRS = new Set(["node_modules"]);

export interface RefreshStats {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  ms: number;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
  tags: string[];
}

export interface SearchOptions {
  limit?: number;
  path?: string; // folder prefix filter
  tag?: string;
  raw?: boolean; // query is FTS5 syntax, passed through
}

export interface NoteRecord {
  path: string;
  title: string;
  frontmatter: Frontmatter;
  tags: string[];
  aliases: string[];
  headings: string[];
  links: Link[];
  mtime: number;
  content: string;
}

export class Store {
  readonly vault: string;
  readonly db: DatabaseSync;

  private constructor(vault: string, db: DatabaseSync) {
    this.vault = vault;
    this.db = db;
  }

  static open(vault: string, opts: { rebuild?: boolean } = {}): Store {
    const dir = join(vault, ".brain");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "index.db"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    const store = new Store(vault, db);
    store.migrate(opts.rebuild ?? false);
    return store;
  }

  close(): void {
    this.db.close();
  }

  private migrate(rebuild: boolean): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (!rebuild && row && Number(row.value) === SCHEMA_VERSION) return;

    // The index is a cache of the vault: on a version change or --rebuild it is
    // dropped and recreated, never migrated.
    this.db.exec(`
      DROP TABLE IF EXISTS notes;
      DROP TABLE IF EXISTS links;
      DROP TABLE IF EXISTS notes_fts;
      CREATE TABLE notes (
        id          INTEGER PRIMARY KEY,
        path        TEXT NOT NULL UNIQUE,
        mtime       REAL NOT NULL,
        size        INTEGER NOT NULL,
        hash        TEXT NOT NULL,
        title       TEXT NOT NULL,
        frontmatter TEXT NOT NULL,
        tags        TEXT NOT NULL,
        aliases     TEXT NOT NULL,
        headings    TEXT NOT NULL
      );
      CREATE TABLE links (
        src     TEXT NOT NULL,
        target  TEXT NOT NULL,
        heading TEXT
      );
      CREATE INDEX links_src ON links(src);
      CREATE INDEX links_target ON links(target COLLATE NOCASE);
      CREATE VIRTUAL TABLE notes_fts USING fts5(
        title, aliases, headings, tags, body,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
    `);
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(SCHEMA_VERSION));
  }

  refresh(): RefreshStats {
    const started = performance.now();
    const stats: RefreshStats = { added: 0, updated: 0, removed: 0, unchanged: 0, ms: 0 };

    const known = new Map<string, { mtime: number; size: number; hash: string }>();
    for (const r of this.db.prepare("SELECT path, mtime, size, hash FROM notes").all() as {
      path: string;
      mtime: number;
      size: number;
      hash: string;
    }[]) {
      known.set(r.path, { mtime: r.mtime, size: r.size, hash: r.hash });
    }

    const seen = new Set<string>();
    const touchStat = this.db.prepare("UPDATE notes SET mtime = ?, size = ? WHERE path = ?");

    this.db.exec("BEGIN");
    try {
      for (const abs of walk(this.vault)) {
        const rel = toPosix(relative(this.vault, abs));
        seen.add(rel);
        const st = statSync(abs);
        const prev = known.get(rel);
        if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) {
          stats.unchanged++;
          continue;
        }
        const content = readFileSync(abs, "utf8");
        const hash = createHash("sha256").update(content).digest("hex");
        if (prev && prev.hash === hash) {
          // Touched but not edited (git checkout, sync tools): no re-parse.
          touchStat.run(st.mtimeMs, st.size, rel);
          stats.unchanged++;
          continue;
        }
        this.write(rel, content, hash, st.mtimeMs, st.size);
        if (prev) stats.updated++;
        else stats.added++;
      }

      for (const path of known.keys()) {
        if (seen.has(path)) continue;
        this.remove(path);
        stats.removed++;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    stats.ms = Math.round(performance.now() - started);
    return stats;
  }

  private remove(path: string): void {
    const row = this.db.prepare("SELECT id FROM notes WHERE path = ?").get(path) as { id: number } | undefined;
    if (!row) return;
    // notes_fts rows share the note's id as their rowid, so this is a keyed delete.
    this.db.prepare("DELETE FROM notes_fts WHERE rowid = ?").run(row.id);
    this.db.prepare("DELETE FROM links WHERE src = ?").run(path);
    this.db.prepare("DELETE FROM notes WHERE id = ?").run(row.id);
  }

  private write(path: string, content: string, hash: string, mtime: number, size: number): void {
    const note = parseNote(path, content);
    this.remove(path);
    const { lastInsertRowid: id } = this.db
      .prepare(
        `INSERT INTO notes (path, mtime, size, hash, title, frontmatter, tags, aliases, headings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        path,
        mtime,
        size,
        hash,
        note.title,
        JSON.stringify(note.frontmatter),
        JSON.stringify(note.tags),
        JSON.stringify(note.aliases),
        JSON.stringify(note.headings),
      );
    const insertLink = this.db.prepare("INSERT INTO links (src, target, heading) VALUES (?, ?, ?)");
    for (const l of note.links) insertLink.run(path, l.target, l.heading);
    this.db
      .prepare("INSERT INTO notes_fts (rowid, title, aliases, headings, tags, body) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, note.title, note.aliases.join(" "), note.headings.join("\n"), note.tags.join(" "), note.body);
  }

  // Machine-local bookkeeping (e.g. the hash brain last exported to a path).
  // It lives in the cache on purpose: losing it only makes exports cautious.
  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  count(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM notes").get() as { n: number }).n;
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const match = opts.raw ? query : toMatchExpression(query);
    if (!match) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));

    const where = ["notes_fts MATCH ?"];
    const params: (string | number)[] = [match];
    if (opts.path) {
      where.push("(n.path = ? OR n.path LIKE ? ESCAPE '\\')");
      const prefix = toPosix(opts.path).replace(/^\.?\/+|\/+$/g, "");
      params.push(prefix, escapeLike(prefix) + "/%");
    }
    if (opts.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)");
      params.push(opts.tag.replace(/^#/, "").toLowerCase());
    }

    // Column weights: a hit in the title or an alias says far more about what a
    // note is *about* than the same word in passing in its body.
    const rows = this.db
      .prepare(
        `SELECT n.path, n.title, n.tags,
                bm25(notes_fts, 10.0, 8.0, 4.0, 4.0, 1.0) AS rank,
                snippet(notes_fts, 4, '[', ']', '…', 16) AS snippet
           FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
          WHERE ${where.join(" AND ")}
          ORDER BY rank, n.path
          LIMIT ?`,
      )
      .all(...params, limit) as { path: string; title: string; tags: string; rank: number; snippet: string }[];

    return rows.map((r) => ({
      path: r.path,
      title: r.title,
      score: round(-r.rank),
      snippet: r.snippet.replace(/\s+/g, " ").trim(),
      tags: JSON.parse(r.tags) as string[],
    }));
  }

  // Resolve a reference the way an Obsidian wiki-link does: exact path, path
  // without extension, then note name / title / alias, case-insensitively.
  resolve(ref: string): string[] {
    const clean = toPosix(ref.trim()).replace(/^\.\//, "");
    const withExt = /\.md$/i.test(clean) ? clean : `${clean}.md`;
    const exact = this.db
      .prepare("SELECT path FROM notes WHERE path = ? COLLATE NOCASE OR path = ? COLLATE NOCASE")
      .all(clean, withExt) as { path: string }[];
    if (exact.length) return exact.map((r) => r.path);

    const name = basename(clean).toLowerCase();
    const all = this.db.prepare("SELECT path, title, aliases FROM notes").all() as {
      path: string;
      title: string;
      aliases: string;
    }[];
    const byName = all.filter((r) => basename(r.path).toLowerCase() === name);
    if (byName.length) return byName.map((r) => r.path).sort();
    return all
      .filter(
        (r) =>
          r.title.toLowerCase() === name ||
          (JSON.parse(r.aliases) as string[]).some((a) => a.toLowerCase() === name),
      )
      .map((r) => r.path)
      .sort();
  }

  get(path: string): NoteRecord | null {
    const r = this.db.prepare("SELECT * FROM notes WHERE path = ?").get(path) as
      | {
          path: string;
          title: string;
          frontmatter: string;
          tags: string;
          aliases: string;
          headings: string;
          mtime: number;
        }
      | undefined;
    if (!r) return null;
    const links = this.db.prepare("SELECT target, heading FROM links WHERE src = ?").all(path) as unknown as Link[];
    return {
      path: r.path,
      title: r.title,
      frontmatter: JSON.parse(r.frontmatter) as Frontmatter,
      tags: JSON.parse(r.tags) as string[],
      aliases: JSON.parse(r.aliases) as string[],
      headings: JSON.parse(r.headings) as string[],
      links,
      mtime: r.mtime,
      content: readFileSync(join(this.vault, ...path.split("/")), "utf8"),
    };
  }
}

// Turn a natural-language query into an FTS5 expression. Terms are OR-ed and
// left to bm25 to rank: an agent asks "interview prep for frontend roles", and
// a note matching three of four words should still come back — first if it
// matches the rare ones. Quoted phrases in the query are kept as phrases.
const STOP = new Set(
  "a an and are as at be but by for from has have how i in is it its me my of on or our so that the their this to was what when where which who why will with you your".split(
    " ",
  ),
);

export function toMatchExpression(query: string): string {
  const parts: string[] = [];
  const phraseRe = /"([^"]+)"/g;
  for (const m of query.matchAll(phraseRe)) {
    const words = tokens(m[1]!);
    if (words.length) parts.push(`"${words.join(" ")}"`);
  }
  const rest = query.replace(phraseRe, " ");
  const all = tokens(rest);
  const content = all.filter((w) => !STOP.has(w));
  // A query made only of stop words ("what is it") still searches for them.
  for (const w of new Set(content.length ? content : all)) parts.push(`"${w}"`);
  return parts.join(" OR ");
}

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 0);
}

function* walk(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      yield full;
    }
  }
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
