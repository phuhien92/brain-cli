#!/usr/bin/env bash
# End-to-end check that a real Pi picks up brain: installs the skill and
# extension into a throwaway HOME, points Pi at a local fake model that records
# each request, and asserts the request carries the `brain` skill and exactly
# one <brain> primer per session — on the first turn and still one on the second.
#
#   scripts/verify-pi.sh            # uses `npx @earendil-works/pi-coding-agent`
#   PI=/path/to/pi scripts/verify-pi.sh
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'kill ${SRV:-0} 2>/dev/null || true; rm -rf "$WORK"' EXIT
PORT=${PORT:-47611}
PI=${PI:-"npx --yes @earendil-works/pi-coding-agent"}

mkdir -p "$WORK/home" "$WORK/bin" "$WORK/vault/.obsidian"
printf '#!/bin/sh\nexec "%s/bin/brain.js" "$@"\n' "$ROOT" > "$WORK/bin/brain" && chmod +x "$WORK/bin/brain"
export HOME="$WORK/home" PATH="$WORK/bin:$PATH" BRAIN_VAULT="$WORK/vault" BRAIN_CONFIG="$WORK/none.json" BRAIN_MACHINE=ci

brain log add learning "pnpm cache breaks after macOS updates" -q
brain agent install pi -q

cat > "$WORK/server.mjs" <<JS
import http from "node:http"; import fs from "node:fs"; let n = 0;
http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
  fs.writeFileSync("$WORK/req." + ++n + ".json", b);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
  send({ id: "1", object: "chat.completion.chunk", created: 0, model: "fake-1", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] });
  send({ id: "1", object: "chat.completion.chunk", created: 0, model: "fake-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  res.end("data: [DONE]\n\n"); }); }).listen($PORT, "127.0.0.1");
JS
cat > "$WORK/fake-provider.ts" <<TS
export default function (pi: any) {
  pi.registerProvider("fake", { baseUrl: "http://127.0.0.1:$PORT/v1", apiKey: "x", api: "openai-completions",
    models: [{ id: "fake-1", name: "Fake", api: "openai-completions", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] });
}
TS
node "$WORK/server.mjs" & SRV=$!
sleep 1

(cd "$WORK" && $PI --print --no-session --extension "$WORK/fake-provider.ts" --provider fake --model fake-1 \
  "first question" "second question" </dev/null >/dev/null)

node - "$WORK" <<'JS'
const fs = require("node:fs");
const dir = process.argv[2];
const reqs = [1, 2].map((n) => JSON.stringify(JSON.parse(fs.readFileSync(`${dir}/req.${n}.json`, "utf8")).messages));
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
if (!reqs[0].includes("<name>brain</name>")) fail("the brain skill is not listed in Pi's system prompt");
for (const [i, r] of reqs.entries()) {
  const n = r.split("<brain>").length - 1;
  if (n !== 1) fail(`request ${i + 1} carries ${n} <brain> primers, expected exactly 1`);
}
if (!reqs[0].includes("pnpm cache breaks")) fail("the primer does not carry recent memory");
console.log("ok: Pi lists the brain skill and injects one primer per session");
JS
