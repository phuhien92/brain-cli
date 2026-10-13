import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFrontmatter, parseNote, parseWikiLink } from "../src/note.js";

test("frontmatter: scalars, inline lists, block lists, empty keys", () => {
  const fm = parseFrontmatter(
    [
      "title: Weekly review",
      "category: current-state",
      "as-of: 2026-10-13",
      "count: 3",
      "draft: false",
      'quoted: "a: b # not a comment"',
      "tags: [career, 'job search']",
      "aliases:",
      "  - Review",
      "  - WR",
      "empty:",
    ].join("\n"),
  );
  assert.deepEqual(fm, {
    title: "Weekly review",
    category: "current-state",
    "as-of": "2026-10-13",
    count: 3,
    draft: false,
    quoted: "a: b # not a comment",
    tags: ["career", "job search"],
    aliases: ["Review", "WR"],
    empty: null,
  });
});

test("wiki-links: alias, heading, block ref, escaped table pipe, same-note link", () => {
  assert.deepEqual(parseWikiLink("Career HQ/CLAUDE|Career HQ"), { target: "Career HQ/CLAUDE", heading: null });
  assert.deepEqual(parseWikiLink("Note#Section|alias"), { target: "Note", heading: "Section" });
  assert.deepEqual(parseWikiLink("Note#^abc123"), { target: "Note", heading: "abc123" });
  assert.deepEqual(parseWikiLink("Email HQ/CLAUDE\\|Email HQ"), { target: "Email HQ/CLAUDE", heading: null });
  assert.equal(parseWikiLink("#Local heading"), null);
});

test("title prefers frontmatter, then first H1, then file name", () => {
  assert.equal(parseNote("a/x.md", "---\ntitle: From FM\n---\n# H1\n").title, "From FM");
  assert.equal(parseNote("a/x.md", "intro\n# The H1\n").title, "The H1");
  assert.equal(parseNote("a/My Note.md", "no heading").title, "My Note");
});

test("tags and links inside code are ignored; inline and frontmatter tags merge", () => {
  const note = parseNote(
    "n.md",
    [
      "---",
      "tags: [Alpha]",
      'related: "[[Other Note]]"',
      "---",
      "Body with #beta and #nested/tag but not #123 or a url.com/#frag.",
      "See [[Linked]] and ![[image.png]].",
      "`#notatag [[notalink]]`",
      "```",
      "#include <stdio.h>",
      "[[also not a link]]",
      "```",
    ].join("\n"),
  );
  assert.deepEqual(note.tags.sort(), ["alpha", "beta", "nested/tag"]);
  assert.deepEqual(
    note.links.map((l) => l.target).sort(),
    ["Linked", "Other Note", "image.png"],
  );
});
