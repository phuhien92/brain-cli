// "Is there a newer brain?" Answered without ever slowing or failing a command:
//
// - At most once a day, after a command has finished, a detached background
//   process asks GitHub for the repository's version tags and records the
//   highest one in update-check.json. The request carries nothing but itself:
//   no install id, no vault, no command data.
// - A person at a terminal then sees one line on stderr, at most once a day.
//   Never with --json or --quiet, never in CI, never in a hook or a script.
// - Agents read it from `brain doctor` instead; the session primer stays quiet.
//
// On by default, unlike telemetry, because nothing is sent. Off with
// BRAIN_NO_UPDATE_CHECK=1 or "updates": { "check": false } in the machine config.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "./paths.js";
export const REPO = "phuhien92/brain-cli";
const TAGS_URL = `https://api.github.com/repos/${REPO}/tags?per_page=100`;
const DAY_MS = 24 * 60 * 60 * 1000;
export const updateFile = () => join(stateRoot(), "update-check.json");
export function readState() {
    try {
        const s = JSON.parse(readFileSync(updateFile(), "utf8"));
        return {
            latest: typeof s.latest === "string" && parseVersion(s.latest) ? s.latest : null,
            checkedAt: typeof s.checkedAt === "number" ? s.checkedAt : 0,
            notifiedAt: typeof s.notifiedAt === "number" ? s.notifiedAt : 0,
        };
    }
    catch {
        return { latest: null, checkedAt: 0, notifiedAt: 0 };
    }
}
function writeState(s) {
    mkdirSync(stateRoot(), { recursive: true });
    const tmp = `${updateFile()}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
    renameSync(tmp, updateFile());
}
// Why the check is off, or null when it is on.
export function disabledReason(configCheck) {
    if (process.env.BRAIN_NO_UPDATE_CHECK)
        return "BRAIN_NO_UPDATE_CHECK is set";
    if (configCheck === false)
        return '"updates": { "check": false } in the machine config';
    if (process.env.CI)
        return "running in CI";
    return null;
}
// Plain releases only: "1.2.3" or "v1.2.3". A pre-release is never announced.
export function parseVersion(v) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function isNewer(candidate, current) {
    const a = parseVersion(candidate);
    const b = parseVersion(current);
    if (!a || !b)
        return false;
    for (let i = 0; i < 3; i++)
        if (a[i] !== b[i])
            return a[i] > b[i];
    return false;
}
export function installCommand(version) {
    return `npm install -g github:${REPO}${version ? `#v${version}` : ""}`;
}
// The highest plain version among the repository's tags.
export function highestTag(tags) {
    if (!Array.isArray(tags))
        return null;
    let best = null;
    for (const t of tags) {
        const name = t?.name;
        if (typeof name !== "string" || !parseVersion(name))
            continue;
        const v = name.replace(/^v/, "");
        if (!best || isNewer(v, best))
            best = v;
    }
    return best;
}
// Ask GitHub now. Used by the background process and by `brain update --check`.
export async function check(version) {
    const s = readState();
    s.checkedAt = Date.now();
    try {
        const res = await fetch(process.env.BRAIN_UPDATE_URL || TAGS_URL, {
            headers: { accept: "application/vnd.github+json", "user-agent": `brain-cli/${version}` },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
            writeState(s);
            return { latest: s.latest, error: `GitHub answered ${res.status}` };
        }
        s.latest = highestTag(await res.json());
        writeState(s);
        return { latest: s.latest, error: null };
    }
    catch (err) {
        writeState(s);
        return { latest: s.latest, error: err.message };
    }
}
// After a command: start the daily check in the background if one is due.
// Never throws, never waits, never writes to stdout.
export function maybeCheck(configCheck, binPath) {
    try {
        if (process.env.BRAIN_BACKGROUND || disabledReason(configCheck))
            return;
        const s = readState();
        if (Date.now() - s.checkedAt < DAY_MS || !existsSync(binPath))
            return;
        s.checkedAt = Date.now(); // claim it, so parallel commands do not all check
        writeState(s);
        const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", binPath, "update", "--check", "--quiet"], {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, BRAIN_BACKGROUND: "1" },
        });
        child.unref();
    }
    catch {
        // An update check must never affect a command.
    }
}
// The one stderr line for a person, or null. Records that it was shown.
export function notice(opts) {
    try {
        const tty = opts.tty ?? process.stderr.isTTY === true;
        if (!tty || opts.json || opts.quiet || process.env.BRAIN_BACKGROUND)
            return null;
        if (disabledReason(opts.configCheck))
            return null;
        // A hook's output is read by an agent, and `update` says it itself.
        if (["context", "update", "unknown"].includes(opts.command.split(".")[0]))
            return null;
        const s = readState();
        const now = opts.now ?? Date.now();
        if (!s.latest || !isNewer(s.latest, opts.version) || now - s.notifiedAt < DAY_MS)
            return null;
        s.notifiedAt = now;
        writeState(s);
        return `brain ${s.latest} is available (you have ${opts.version}): ${installCommand(s.latest)}`;
    }
    catch {
        return null;
    }
}
export function status(version, configCheck) {
    const s = readState();
    const reason = disabledReason(configCheck);
    const available = !!s.latest && isNewer(s.latest, version);
    return {
        current: version,
        latest: s.latest,
        available,
        checkedAt: s.checkedAt ? new Date(s.checkedAt).toISOString() : null,
        enabled: reason === null,
        reason,
        command: installCommand(available ? s.latest : null),
    };
}
