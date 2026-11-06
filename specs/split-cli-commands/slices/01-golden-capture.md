# 01: Golden capture

**Question:** Can we prove the CLI's output is byte-identical before and after, beyond what the tests assert?

**Seam:** `specs/split-cli-commands/golden.sh capture|check`. It builds a fixture vault in a temp folder, runs `node bin/brain.js` for each deterministic command (with and without `--json`) and records stdout, stderr and exit code under `specs/split-cli-commands/golden/`. `check` reruns and diffs.

**Check:** `golden.sh capture` run twice gives identical files (`git diff --stat` empty after the second run). `golden.sh check` prints nothing and exits 0 on the unchanged code; it exits 1 with a diff if any byte or exit code changes.

**Must stay green:** `npm test` (149 pass); no product code changes in this slice.

**Decided:**
- Normalize only what differs run to run: the temp vault path, timestamps, and generated IDs. Anything else that differs is a real change.
- Cover at least `help`, `path`, `view`, `search`, `get`, `log list`, `lifecycle`, `lint`, `integrations`, `doctor`, and one error case per exit code the fixture can reach.
- Disable the update check and telemetry in the fixture (`BRAIN_NO_UPDATE_CHECK=1`, telemetry off).

**Delegated to the worker:**
- The fixture notes and the exact command list beyond the minimum.

**Out of scope:**
- Commands that need the network or a git remote (`sync` in git mode, `update`, `feedback` posting): covered by the test suite only.
