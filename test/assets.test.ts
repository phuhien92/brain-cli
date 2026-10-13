import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const logo = readFileSync(join(ROOT, "assets/logo.svg"), "utf8");
const banner = readFileSync(join(ROOT, "assets/banner.svg"), "utf8");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const design = readFileSync(join(ROOT, "design/brain-ui.pen"), "utf8");
const tokenDocument = JSON.parse(readFileSync(join(ROOT, "design/tokens.json"), "utf8")) as {
  format: string;
  source: string;
  tokens: Record<string, { type: string; value: string | number }>;
};
const BRIGHT_COLORS = new Set(
  Object.values(tokenDocument.tokens)
    .filter((token) => token.type === "color")
    .map((token) => String(token.value).toUpperCase()),
);

const LEGACY_IDENTITY_COLORS = [
  "#0F0D2E",
  "#1E1B4B",
  "#312E81",
  "#3730A3",
  "#4338CA",
  "#6366F1",
  "#818CF8",
  "#A5B4FC",
  "#C7D2FE",
  "#E0E7FF",
  "#FBBF24",
];

function colors(svg: string): Set<string> {
  return new Set([...svg.matchAll(/#[0-9a-f]{6}\b/gi)].map(([color]) => color.toUpperCase()));
}

test("brand assets use only the canonical Bright local-first palette", () => {
  assert.equal(tokenDocument.format, "brain.design-tokens.v1");
  assert.equal(tokenDocument.source, "design/brain-ui.pen");
  for (const [name, svg] of [["logo", logo], ["banner", banner]] as const) {
    assert.doesNotMatch(svg, /linearGradient/, `${name} must use flat semantic-token colors`);
    for (const color of colors(svg)) {
      assert.ok(BRIGHT_COLORS.has(color), `${name} uses non-token color ${color}`);
    }
    for (const color of LEGACY_IDENTITY_COLORS) {
      assert.ok(!svg.toUpperCase().includes(color), `${name} still uses legacy identity color ${color}`);
    }
  }
});

test("the canonical Pen source contains the approved brand and no legacy identity colors", () => {
  const document = JSON.parse(design) as { version: string; children: Array<{ name?: string }> };
  assert.equal(document.version, "2.21");
  assert.ok(document.children.some((node) => node.name === "17 · Brand approved · Product chrome"));
  assert.ok(document.children.some((node) => node.name === "18 · Brand approved · Recommendation and usage"));
  for (const color of LEGACY_IDENTITY_COLORS) {
    assert.ok(!design.toUpperCase().includes(color), `canonical Pen source still uses ${color}`);
  }
});

test("brand assets preserve Brain's linked-vault meaning and product positioning", () => {
  assert.match(logo, /double wiki-link brackets/i);
  assert.match(logo, /linked graph of notes/i);
  assert.match(banner, /Headless memory for your markdown vault\./);
  assert.match(banner, /For any agent, on any machine\./);
  assert.match(banner, /LOCAL-FIRST\s+·\s+RANKED SEARCH\s+·\s+ZERO RUNTIME DEPS/);
  assert.match(banner, /brain search &quot;deploy gotchas&quot;/);
});

test("the README dependency badge follows the revised brand palette", () => {
  assert.match(readme, /runtime%20deps-0-075E46/);
  assert.doesNotMatch(readme, /runtime%20deps-0-4338CA/);
});
