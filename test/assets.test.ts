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
  backgroundGradient: {
    role: string;
    type: "linear";
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    penRotation: number;
    startToken: string;
    endToken: string;
  };
  foregroundDarkToken: string;
  foregroundLightToken: string;
  logo: {
    viewBox: number[];
    bracketPath: string;
    graphPath: string;
    foregroundToken: string;
    haloToken: string;
    accentToken: string;
    nodes: Array<{ cx: number; cy: number; r: number; role: "paper" | "focus" }>;
  };
  banner: {
    width: number;
    height: number;
    backgroundRole: string;
    wordmarkToken: string;
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
type PenGradient = {
  type: "gradient";
  gradientType?: string;
  rotation?: number;
  colors?: Array<{ color: string; position: number }>;
};
type PenNode = {
  id: string;
  type: string;
  name?: string;
  content?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string | PenGradient;
  stroke?: string | PenGradient;
  strokeWidth?: number;
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

function isPenGradient(fill: PenNode["fill"]): fill is PenGradient {
  return typeof fill === "object" && fill?.type === "gradient";
}

function assertPenGradient(fill: PenNode["fill"]): void {
  assert.ok(isPenGradient(fill));
  assert.equal(fill.gradientType, "linear");
  assert.equal(fill.rotation, tokenDocument.brand.backgroundGradient.penRotation);
  assert.deepEqual(fill.colors, [
    { color: "$brandBackgroundStart", position: 0 },
    { color: "$brandBackgroundEnd", position: 1 },
  ]);
}

function assertCanonicalPenMark(mark: PenNode): void {
  assert.ok(mark.width);
  assert.equal(mark.height, mark.width);
  const children = mark.children ?? [];
  const parts = children.filter((node) => node.metadata?.type === "brain.logo-part");
  const brackets = parts.filter((node) => node.metadata?.role === "wiki-link-brackets");
  const graphs = parts.filter((node) => node.metadata?.role === "linked-note-graph");
  const nodes = parts
    .filter((node) => node.metadata?.role === "note-node")
    .sort((first, second) => Number(first.metadata?.index) - Number(second.metadata?.index));
  assert.equal(brackets.length, 1, `${mark.name} must have one bracket path`);
  assert.equal(graphs.length, 1, `${mark.name} must have one graph path`);
  assert.equal(nodes.length, tokenDocument.brand.logo.nodes.length, `${mark.name} must have canonical nodes`);
  assert.deepEqual(normalizeLinePath(brackets[0]?.geometry ?? ""), normalizeLinePath(tokenDocument.brand.logo.bracketPath));
  assert.deepEqual(normalizeLinePath(graphs[0]?.geometry ?? ""), normalizeLinePath(tokenDocument.brand.logo.graphPath));

  const scale = mark.width / tokenDocument.brand.logo.viewBox[2]!;
  tokenDocument.brand.logo.nodes.forEach((expected, index) => {
    const node = nodes[index];
    assert.ok(node);
    assert.equal(node.metadata?.index, index + 1);
    assert.equal(node.metadata?.state, expected.role);
    assert.ok(Math.abs((node.x ?? Number.NaN) - (expected.cx - expected.r) * scale) < 1e-9);
    assert.ok(Math.abs((node.y ?? Number.NaN) - (expected.cy - expected.r) * scale) < 1e-9);
    assert.ok(Math.abs((node.width ?? Number.NaN) - expected.r * 2 * scale) < 1e-9);
    assert.ok(Math.abs((node.height ?? Number.NaN) - expected.r * 2 * scale) < 1e-9);
  });

  const halos = children.filter((node) => node.metadata?.type === "brain.logo-halo");
  if (isPenGradient(mark.fill)) {
    assertPenGradient(mark.fill);
    assert.equal(halos.length, 2, `${mark.name} must have bracket and graph halos`);
    const bracketHalo = halos.find((node) => node.metadata?.role === "wiki-link-brackets");
    const graphHalo = halos.find((node) => node.metadata?.role === "linked-note-graph");
    assert.deepEqual(normalizeLinePath(bracketHalo?.geometry ?? ""), normalizeLinePath(tokenDocument.brand.logo.bracketPath));
    assert.deepEqual(normalizeLinePath(graphHalo?.geometry ?? ""), normalizeLinePath(tokenDocument.brand.logo.graphPath));
    assert.equal(bracketHalo?.stroke, "$brandMarkHalo");
    assert.equal(graphHalo?.stroke, "$brandMarkHalo");
    assert.ok((bracketHalo?.strokeWidth ?? 0) > (brackets[0]?.strokeWidth ?? Number.POSITIVE_INFINITY));
    assert.ok((graphHalo?.strokeWidth ?? 0) > (graphs[0]?.strokeWidth ?? Number.POSITIVE_INFINITY));
    assert.equal(brackets[0]?.stroke, "$brandOnLight");
    assert.equal(graphs[0]?.stroke, "$brandOnLight");
    assert.equal(nodes.find((node) => node.metadata?.state === "focus")?.fill, "$brandAccent");
  } else {
    assert.equal(halos.length, 0, `${mark.name} monochrome fallback must stay one-color`);
  }
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

function interpolateHex(first: string, second: string, position: number): string {
  const channels = (hex: string): number[] => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  const start = channels(first);
  const end = channels(second);
  return `#${start.map((channel, index) =>
    Math.round(channel + ((end[index] ?? channel) - channel) * position).toString(16).padStart(2, "0"),
  ).join("")}`;
}

function bannerGradientColorAt(x: number, y: number): string {
  const start = String(resolveToken(tokenDocument.brand.backgroundGradient.startToken));
  const end = String(resolveToken(tokenDocument.brand.backgroundGradient.endToken));
  const position = (x / tokenDocument.brand.banner.width + y / tokenDocument.brand.banner.height) / 2;
  return interpolateHex(start, end, position);
}

const logo = parseSvg(readFileSync(join(ROOT, "assets/logo.svg"), "utf8"));
const banner = parseSvg(readFileSync(join(ROOT, "assets/banner.svg"), "utf8"));

function assertSvgGradient(root: SvgElement): void {
  const gradient = svgById(root, "brand-gradient");
  const contract = tokenDocument.brand.backgroundGradient;
  assert.equal(gradient.tag, "linearGradient");
  assert.equal(Number(gradient.attributes.x1), contract.x1);
  assert.equal(Number(gradient.attributes.y1), contract.y1);
  assert.equal(Number(gradient.attributes.x2), contract.x2);
  assert.equal(Number(gradient.attributes.y2), contract.y2);
  const stops = gradient.children.filter((node) => node.tag === "stop");
  assert.deepEqual(stops.map((stop) => stop.attributes.offset), ["0", "1"]);
  assert.deepEqual(stops.map((stop) => stop.attributes["stop-color"]), [
    resolveToken(contract.startToken),
    resolveToken(contract.endToken),
  ]);
}

function assertCanonicalMark(mark: SvgElement): void {
  const bracket = svgById(mark, "wiki-link-brackets");
  const graph = svgById(mark, "linked-note-graph");
  const bracketHalo = svgById(mark, "wiki-link-brackets-halo");
  const graphHalo = svgById(mark, "linked-note-graph-halo");
  assert.equal(bracket.attributes.d, tokenDocument.brand.logo.bracketPath);
  assert.equal(graph.attributes.d, tokenDocument.brand.logo.graphPath);
  assert.equal(bracketHalo.attributes.d, tokenDocument.brand.logo.bracketPath);
  assert.equal(graphHalo.attributes.d, tokenDocument.brand.logo.graphPath);
  assert.equal(bracket.attributes.stroke, resolveToken(tokenDocument.brand.logo.foregroundToken));
  assert.equal(graph.attributes.stroke, resolveToken(tokenDocument.brand.logo.foregroundToken));
  assert.equal(bracketHalo.attributes.stroke, resolveToken(tokenDocument.brand.logo.haloToken));
  assert.equal(graphHalo.attributes.stroke, resolveToken(tokenDocument.brand.logo.haloToken));
  assert.ok(Number(bracketHalo.attributes["stroke-width"]) > Number(bracket.attributes["stroke-width"]));
  assert.ok(Number(graphHalo.attributes["stroke-width"]) > Number(graph.attributes["stroke-width"]));

  const nodeGroup = svgById(mark, "note-nodes");
  assert.equal(nodeGroup.attributes.fill, resolveToken("brand.paper"));
  assert.equal(nodeGroup.attributes.stroke, resolveToken(tokenDocument.brand.logo.foregroundToken));
  const circles = nodeGroup.children.filter((node) => node.tag === "circle");
  assert.equal(circles.length, tokenDocument.brand.logo.nodes.length);
  tokenDocument.brand.logo.nodes.forEach((expected, index) => {
    const circle = circles[index];
    assert.ok(circle);
    assert.equal(Number(circle.attributes.cx), expected.cx);
    assert.equal(Number(circle.attributes.cy), expected.cy);
    assert.equal(Number(circle.attributes.r), expected.r);
    if (expected.role === "focus") {
      assert.equal(circle.attributes.fill, resolveToken(tokenDocument.brand.logo.accentToken));
    }
  });
}

test("brand contract names one shared accessible green gradient", () => {
  assert.equal(tokenDocument.format, "brain.design-tokens.v1");
  assert.equal(tokenDocument.source, "design/brain-ui.pen");
  assert.equal(tokenDocument.brand.contract, "brain.brand.v1");
  assert.equal(tokenDocument.brand.direction, "A · Linked Vault");
  assert.equal(tokenDocument.brand.lifecycle, "implemented");

  const gradient = tokenDocument.brand.backgroundGradient;
  const start = String(resolveToken(gradient.startToken));
  const end = String(resolveToken(gradient.endToken));
  const onDark = String(resolveToken(tokenDocument.brand.foregroundDarkToken));
  const onLight = String(resolveToken(tokenDocument.brand.foregroundLightToken));
  const accent = String(resolveToken(tokenDocument.brand.logo.accentToken));
  assert.equal(gradient.role, "brand.gradient");
  assert.equal(start, "#075E46");
  assert.equal(end, "#108160");
  assert.equal(onDark, "#F4F8F6");
  assert.equal(onLight, "#052F3E");
  assert.equal(accent, "#FBBF24");
  assert.ok(contrastRatio(onDark, start) >= 4.5);
  assert.ok(contrastRatio(onDark, end) >= 4.5);
  assert.ok(contrastRatio(accent, start) >= 4.5);
  assert.ok(contrastRatio(accent, end) < 3);
  const focusNode = tokenDocument.brand.logo.nodes.find((node) => node.role === "focus");
  assert.ok(focusNode);
  const focusPosition = (focusNode.cx / 128 + focusNode.cy / 128) / 2;
  assert.ok(contrastRatio(accent, interpolateHex(start, end, focusPosition)) >= 3);
});

test("banner light copy passes contrast at its rendered gradient positions", () => {
  const onDark = String(resolveToken(tokenDocument.brand.foregroundDarkToken));
  const wordmark = svgById(banner, "wordmark");
  const positioning = svgById(banner, "positioning");
  const samples = [
    ...wordmark.children.map((path) => {
      const match = /^translate\(([-\d.]+) ([-\d.]+)\)$/.exec(path.attributes.transform ?? "");
      assert.ok(match);
      return { x: Number(match[1]), y: Number(match[2]), threshold: 3 };
    }),
    ...positioning.children.map((text) => ({
      x: Number(text.attributes.x),
      y: Number(text.attributes.y),
      threshold: Number(text.attributes["font-size"]) >= 24 ? 3 : 4.5,
    })),
  ];
  for (const sample of samples) {
    assert.ok(
      contrastRatio(onDark, bannerGradientColorAt(sample.x, sample.y)) >= sample.threshold,
      `light foreground fails at (${sample.x}, ${sample.y})`,
    );
  }
});

test("logo and banner share the canonical gradient and Linked Vault geometry", () => {
  assert.equal(logo.tag, "svg");
  assert.equal(banner.tag, "svg");
  assert.equal(logo.attributes.viewBox, tokenDocument.brand.logo.viewBox.join(" "));
  assert.equal(Number(banner.attributes.width), tokenDocument.brand.banner.width);
  assert.equal(Number(banner.attributes.height), tokenDocument.brand.banner.height);
  assert.equal(banner.attributes.viewBox, `0 0 ${tokenDocument.brand.banner.width} ${tokenDocument.brand.banner.height}`);

  assertSvgGradient(logo);
  assertSvgGradient(banner);
  assert.equal(svgById(logo, "brand-background").attributes.fill, "url(#brand-gradient)");
  assert.equal(svgById(banner, "brand-background").attributes.fill, "url(#brand-gradient)");
  assert.equal(svgById(banner, "mark-background").attributes.fill, "url(#brand-gradient)");
  assertCanonicalMark(svgById(logo, "linked-vault-mark"));
  assertCanonicalMark(svgById(banner, "linked-vault-mark"));
});

test("banner display wordmark is outlined and supporting copy uses declared portable stacks", () => {
  assert.equal(tokenDocument.brand.banner.wordmarkRendering, "outlined-paths");
  const wordmark = svgById(banner, "wordmark");
  assert.equal(wordmark.attributes.fill, resolveToken(tokenDocument.brand.banner.wordmarkToken));
  assert.equal(svgDescendants(wordmark).filter((node) => node.tag === "text").length, 0);
  const paths = wordmark.children.filter((node) => node.tag === "path");
  assert.equal(paths.length, 2);
  assert.equal(paths[0]?.attributes["data-font-family"], resolveToken(tokenDocument.brand.banner.brainTypefaceToken));
  assert.equal(paths[1]?.attributes["data-font-family"], resolveToken(tokenDocument.brand.banner.cliTypefaceToken));

  const positioning = svgById(banner, "positioning");
  assert.equal(positioning.attributes.fill, resolveToken(tokenDocument.brand.foregroundDarkToken));
  assert.equal(positioning.attributes["font-family"], resolveToken(tokenDocument.brand.banner.supportingSansToken));
  const monoText = positioning.children.find((node) => node.attributes["font-family"] !== undefined);
  assert.equal(monoText?.attributes["font-family"], resolveToken(tokenDocument.brand.banner.supportingMonoToken));
});

test("serialized SVG output uses one tokenized gradient and only declared colors", () => {
  const allowed = new Set(
    Object.entries(tokenDocument.tokens)
      .filter(([, token]) => token.type === "color")
      .map(([name]) => String(resolveToken(name)).toUpperCase()),
  );
  for (const [name, root] of [["logo", logo], ["banner", banner]] as const) {
    assert.equal([root, ...svgDescendants(root)].filter((node) => node.tag === "linearGradient").length, 1);
    for (const node of [root, ...svgDescendants(root)]) {
      for (const attribute of ["fill", "stroke", "stop-color"] as const) {
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
  assert.equal(resolvePenVariable("brandBackgroundStart"), resolveToken(tokenDocument.brand.backgroundGradient.startToken));
  assert.equal(resolvePenVariable("brandBackgroundEnd"), resolveToken(tokenDocument.brand.backgroundGradient.endToken));
  assert.equal(resolvePenVariable("brandOnDark"), resolveToken(tokenDocument.brand.foregroundDarkToken));
  assert.equal(resolvePenVariable("brandOnLight"), resolveToken(tokenDocument.brand.foregroundLightToken));
  assert.equal(resolvePenVariable("brandMarkHalo"), resolveToken(tokenDocument.brand.logo.haloToken));
  assert.equal(resolvePenVariable("brandAccent"), resolveToken(tokenDocument.brand.logo.accentToken));

  const logoSource = penByMetadataType("brain.logo.v1");
  assert.equal(logoSource.metadata?.state, "implemented");
  assert.equal(logoSource.metadata?.backgroundToken, tokenDocument.brand.backgroundGradient.role);
  assert.equal(logoSource.metadata?.backgroundStartToken, tokenDocument.brand.backgroundGradient.startToken);
  assert.equal(logoSource.metadata?.backgroundEndToken, tokenDocument.brand.backgroundGradient.endToken);
  assertPenGradient(logoSource.fill);
  const logoParts = penDescendants(logoSource.children ?? []);
  const penBracketPath = logoParts.find((node) => node.metadata?.role === "wiki-link-brackets")?.geometry;
  const penGraphPath = logoParts.find((node) => node.metadata?.role === "linked-note-graph")?.geometry;
  assert.ok(penBracketPath);
  assert.ok(penGraphPath);
  assert.deepEqual(normalizeLinePath(penBracketPath), normalizeLinePath(tokenDocument.brand.logo.bracketPath));
  assert.deepEqual(normalizeLinePath(penGraphPath), normalizeLinePath(tokenDocument.brand.logo.graphPath));

  const logoCopies = penDescendants(penDocument.children).filter((node) =>
    node.children?.some((child) => child.metadata?.type === "brain.logo-part"),
  );
  assert.equal(logoCopies.length, 18);
  assert.equal(logoCopies.filter((node) => isPenGradient(node.fill)).length, 15);
  logoCopies.forEach(assertCanonicalPenMark);

  const bannerSource = penByMetadataType("brain.banner.v1");
  assert.equal(bannerSource.metadata?.state, "implemented");
  assert.equal(bannerSource.width, tokenDocument.brand.banner.width);
  assert.equal(bannerSource.height, tokenDocument.brand.banner.height);
  assert.equal(bannerSource.metadata?.backgroundToken, tokenDocument.brand.backgroundGradient.role);
  assertPenGradient(bannerSource.fill);
  assert.equal(bannerSource.metadata?.wordmarkRendering, tokenDocument.brand.banner.wordmarkRendering);
  assert.equal(penDescendants(bannerSource.children ?? []).filter((node) => node.metadata?.type === "brain.outlined-wordmark").length, 2);

  const lifecycle = penByMetadataType("brain.brand-lifecycle.v1");
  assert.equal(lifecycle.metadata?.state, tokenDocument.brand.lifecycle);
  assert.equal(lifecycle.content, "BRAND HANDOFF · IMPLEMENTED");
});
