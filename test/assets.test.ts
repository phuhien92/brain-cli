import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type Token = { type: string; value: string | number };
type BrandContract = {
  contract: string;
  direction: string;
  lifecycle: string;
  backgroundToken: string;
  foregroundToken: string;
  logo: {
    viewBox: number[];
    bracketPath: string;
    graphPath: string;
    nodes: Array<{ cx: number; cy: number; r: number; role: "paper" | "focus" }>;
  };
  banner: {
    width: number;
    height: number;
    backgroundToken: string;
    wordmarkRendering: string;
    brainTypefaceToken: string;
    cliTypefaceToken: string;
    supportingSansToken: string;
    supportingMonoToken: string;
  };
};
type TokenDocument = {
  format: string;
  source: string;
  brand: BrandContract;
  tokens: Record<string, Token>;
};
type SvgElement = {
  tag: string;
  attributes: Record<string, string>;
  children: SvgElement[];
};
type PenNode = {
  id: string;
  type: string;
  name?: string;
  content?: string;
  width?: number;
  height?: number;
  fill?: string;
  geometry?: string;
  metadata?: Record<string, unknown>;
  children?: PenNode[];
};
type PenDocument = {
  version: string;
  variables: Record<string, { type: string; value: string | number }>;
  children: PenNode[];
};

const tokenDocument = JSON.parse(readFileSync(join(ROOT, "design/tokens.json"), "utf8")) as TokenDocument;
const penDocument = JSON.parse(readFileSync(join(ROOT, "design/brain-ui.pen"), "utf8")) as PenDocument;

function resolveToken(name: string, seen = new Set<string>()): string | number {
  assert.ok(!seen.has(name), `token alias cycle at ${name}`);
  const token = tokenDocument.tokens[name];
  assert.ok(token, `missing token ${name}`);
  if (token.type !== "alias") return token.value;
  assert.ok(typeof token.value === "string", `${name} alias must be a string`);
  const match = /^\{([^}]+)\}$/.exec(token.value);
  assert.ok(match?.[1], `${name} has an invalid alias`);
  return resolveToken(match[1], new Set([...seen, name]));
}

function resolvePenVariable(name: string, seen = new Set<string>()): string | number {
  assert.ok(!seen.has(name), `Pen variable cycle at ${name}`);
  const variable = penDocument.variables[name];
  assert.ok(variable, `missing Pen variable ${name}`);
  if (typeof variable.value !== "string" || !variable.value.startsWith("$")) return variable.value;
  return resolvePenVariable(variable.value.slice(1), new Set([...seen, name]));
}

function parseSvg(source: string): SvgElement {
  const synthetic: SvgElement = { tag: "document", attributes: {}, children: [] };
  const stack = [synthetic];
  for (const tokenMatch of source.matchAll(/<!--[\s\S]*?-->|<[^>]+>/g)) {
    const token = tokenMatch[0];
    if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<!")) continue;
    if (token.startsWith("</")) {
      assert.ok(stack.length > 1, "unexpected SVG closing tag");
      stack.pop();
      continue;
    }
    const tagMatch = /^<([A-Za-z][\w:-]*)\b/.exec(token);
    assert.ok(tagMatch?.[1], `invalid SVG tag ${token}`);
    const attributes: Record<string, string> = {};
    for (const match of token.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
      const [, key, value] = match;
      assert.ok(key !== undefined && value !== undefined);
      attributes[key] = value;
    }
    const element: SvgElement = { tag: tagMatch[1], attributes, children: [] };
    const parent = stack.at(-1);
    assert.ok(parent);
    parent.children.push(element);
    if (!token.endsWith("/>")) stack.push(element);
  }
  assert.equal(stack.length, 1, "unclosed SVG element");
  assert.equal(synthetic.children.length, 1, "SVG must have one root element");
  const root = synthetic.children[0];
  assert.ok(root);
  return root;
}

function svgDescendants(node: SvgElement): SvgElement[] {
  return node.children.flatMap((child) => [child, ...svgDescendants(child)]);
}

function svgById(root: SvgElement, id: string): SvgElement {
  const node = [root, ...svgDescendants(root)].find((candidate) => candidate.attributes.id === id);
  assert.ok(node, `missing SVG element #${id}`);
  return node;
}

function penDescendants(nodes: PenNode[]): PenNode[] {
  return nodes.flatMap((node) => [node, ...penDescendants(node.children ?? [])]);
}

function normalizeLinePath(path: string): Array<["M" | "L", number, number]> {
  const tokens = [...path.matchAll(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g)].map((match) => match[0]);
  const result: Array<["M" | "L", number, number]> = [];
  let command = "";
  let index = 0;
  let x = 0;
  let y = 0;
  const number = (): number => {
    const token = tokens[index++];
    assert.ok(token !== undefined && !/^[A-Za-z]$/.test(token), `invalid line path ${path}`);
    return Number(token);
  };
  while (index < tokens.length) {
    const token = tokens[index];
    if (token !== undefined && /^[A-Za-z]$/.test(token)) {
      command = token;
      index += 1;
    }
    assert.ok(command, `line path lacks a command: ${path}`);
    const relative = command === command.toLowerCase();
    switch (command.toUpperCase()) {
      case "M": {
        const nextX = number();
        const nextY = number();
        x = relative ? x + nextX : nextX;
        y = relative ? y + nextY : nextY;
        result.push(["M", x, y]);
        command = relative ? "l" : "L";
        break;
      }
      case "L": {
        const nextX = number();
        const nextY = number();
        x = relative ? x + nextX : nextX;
        y = relative ? y + nextY : nextY;
        result.push(["L", x, y]);
        break;
      }
      case "H": {
        const nextX = number();
        x = relative ? x + nextX : nextX;
        result.push(["L", x, y]);
        break;
      }
      case "V": {
        const nextY = number();
        y = relative ? y + nextY : nextY;
        result.push(["L", x, y]);
        break;
      }
      default:
        assert.fail(`unsupported line path command ${command}`);
    }
  }
  return result;
}

function penByMetadataType(type: string): PenNode {
  const matches = penDescendants(penDocument.children).filter((node) => node.metadata?.type === type);
  assert.equal(matches.length, 1, `expected one Pen node with metadata type ${type}`);
  const match = matches[0];
  assert.ok(match);
  return match;
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const [red = 0, green = 0, blue = 0] = linear;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const [lighter = 0, darker = 0] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const logo = parseSvg(readFileSync(join(ROOT, "assets/logo.svg"), "utf8"));
const banner = parseSvg(readFileSync(join(ROOT, "assets/banner.svg"), "utf8"));

function assertCanonicalMark(mark: SvgElement): void {
  const bracket = [mark, ...svgDescendants(mark)].find((node) => node.attributes.id === "wiki-link-brackets");
  const graph = [mark, ...svgDescendants(mark)].find((node) => node.attributes.id === "linked-note-graph");
  assert.equal(bracket?.attributes.d, tokenDocument.brand.logo.bracketPath);
  assert.equal(graph?.attributes.d, tokenDocument.brand.logo.graphPath);
  assert.equal(bracket?.attributes.stroke, resolveToken(tokenDocument.brand.foregroundToken));
  assert.equal(graph?.attributes.stroke, resolveToken(tokenDocument.brand.foregroundToken));

  const nodeGroup = [mark, ...svgDescendants(mark)].find((node) => node.attributes.id === "note-nodes");
  assert.ok(nodeGroup);
  const circles = nodeGroup.children.filter((node) => node.tag === "circle");
  assert.equal(circles.length, tokenDocument.brand.logo.nodes.length);
  tokenDocument.brand.logo.nodes.forEach((expected, index) => {
    const circle = circles[index];
    assert.ok(circle);
    assert.equal(Number(circle.attributes.cx), expected.cx);
    assert.equal(Number(circle.attributes.cy), expected.cy);
    assert.equal(Number(circle.attributes.r), expected.r);
    if (expected.role === "focus") {
      assert.equal(circle.attributes.fill, resolveToken(tokenDocument.brand.foregroundToken));
    }
  });
}

test("brand contract maps one green background to a readable on-background token", () => {
  assert.equal(tokenDocument.format, "brain.design-tokens.v1");
  assert.equal(tokenDocument.source, "design/brain-ui.pen");
  assert.equal(tokenDocument.brand.contract, "brain.brand.v1");
  assert.equal(tokenDocument.brand.direction, "A · Linked Vault");
  assert.equal(tokenDocument.brand.lifecycle, "implemented");

  const background = resolveToken(tokenDocument.brand.backgroundToken);
  const foreground = resolveToken(tokenDocument.brand.foregroundToken);
  assert.equal(background, "#21C995");
  assert.equal(foreground, "#052F3E");
  assert.ok(contrastRatio(String(background), String(foreground)) >= 4.5);
});

test("logo and banner share the canonical background and Linked Vault geometry", () => {
  assert.equal(logo.tag, "svg");
  assert.equal(banner.tag, "svg");
  assert.equal(logo.attributes.viewBox, tokenDocument.brand.logo.viewBox.join(" "));
  assert.equal(Number(banner.attributes.width), tokenDocument.brand.banner.width);
  assert.equal(Number(banner.attributes.height), tokenDocument.brand.banner.height);
  assert.equal(banner.attributes.viewBox, `0 0 ${tokenDocument.brand.banner.width} ${tokenDocument.brand.banner.height}`);

  const expectedBackground = String(resolveToken(tokenDocument.brand.backgroundToken));
  assert.equal(svgById(logo, "brand-background").attributes.fill, expectedBackground);
  assert.equal(svgById(banner, "brand-background").attributes.fill, expectedBackground);
  assertCanonicalMark(svgById(logo, "linked-vault-mark"));
  assertCanonicalMark(svgById(banner, "linked-vault-mark"));
});

test("banner display wordmark is outlined and supporting copy uses declared portable stacks", () => {
  assert.equal(tokenDocument.brand.banner.wordmarkRendering, "outlined-paths");
  const wordmark = svgById(banner, "wordmark");
  assert.equal(svgDescendants(wordmark).filter((node) => node.tag === "text").length, 0);
  const paths = wordmark.children.filter((node) => node.tag === "path");
  assert.equal(paths.length, 2);
  assert.equal(paths[0]?.attributes["data-font-family"], resolveToken(tokenDocument.brand.banner.brainTypefaceToken));
  assert.equal(paths[1]?.attributes["data-font-family"], resolveToken(tokenDocument.brand.banner.cliTypefaceToken));

  const positioning = svgById(banner, "positioning");
  assert.equal(positioning.attributes["font-family"], resolveToken(tokenDocument.brand.banner.supportingSansToken));
  const monoText = positioning.children.find((node) => node.attributes["font-family"] !== undefined);
  assert.equal(monoText?.attributes["font-family"], resolveToken(tokenDocument.brand.banner.supportingMonoToken));
});

test("serialized SVG output uses only Bright color tokens", () => {
  const allowed = new Set(
    Object.entries(tokenDocument.tokens)
      .filter(([, token]) => token.type === "color")
      .map(([name]) => String(resolveToken(name)).toUpperCase()),
  );
  for (const [name, root] of [["logo", logo], ["banner", banner]] as const) {
    assert.equal([root, ...svgDescendants(root)].some((node) => node.tag === "linearGradient"), false);
    for (const node of [root, ...svgDescendants(root)]) {
      for (const attribute of ["fill", "stroke"] as const) {
        const value = node.attributes[attribute];
        if (value?.startsWith("#")) {
          assert.ok(allowed.has(value.toUpperCase()), `${name} has off-token ${attribute} ${value}`);
        }
      }
    }
  }
});

test("canonical Pen source matches the implemented asset contract", () => {
  assert.equal(penDocument.version, "2.21");
  assert.equal(resolvePenVariable("brandBackground"), resolveToken(tokenDocument.brand.backgroundToken));
  assert.equal(resolvePenVariable("brandOnBackground"), resolveToken(tokenDocument.brand.foregroundToken));

  const logoSource = penByMetadataType("brain.logo.v1");
  assert.equal(logoSource.metadata?.state, "implemented");
  assert.equal(logoSource.fill, "$brandBackground");
  const logoParts = penDescendants(logoSource.children ?? []);
  const penBracketPath = logoParts.find((node) => node.metadata?.role === "wiki-link-brackets")?.geometry;
  const penGraphPath = logoParts.find((node) => node.metadata?.role === "linked-note-graph")?.geometry;
  assert.ok(penBracketPath);
  assert.ok(penGraphPath);
  assert.deepEqual(normalizeLinePath(penBracketPath), normalizeLinePath(tokenDocument.brand.logo.bracketPath));
  assert.deepEqual(normalizeLinePath(penGraphPath), normalizeLinePath(tokenDocument.brand.logo.graphPath));

  const bannerSource = penByMetadataType("brain.banner.v1");
  assert.equal(bannerSource.metadata?.state, "implemented");
  assert.equal(bannerSource.width, tokenDocument.brand.banner.width);
  assert.equal(bannerSource.height, tokenDocument.brand.banner.height);
  assert.equal(bannerSource.fill, "$brandBackground");
  assert.equal(bannerSource.metadata?.wordmarkRendering, tokenDocument.brand.banner.wordmarkRendering);
  assert.equal(penDescendants(bannerSource.children ?? []).filter((node) => node.metadata?.type === "brain.outlined-wordmark").length, 2);

  const lifecycle = penByMetadataType("brain.brand-lifecycle.v1");
  assert.equal(lifecycle.metadata?.state, tokenDocument.brand.lifecycle);
  assert.equal(lifecycle.content, "BRAND HANDOFF · IMPLEMENTED");
});
