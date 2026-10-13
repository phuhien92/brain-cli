// Anonymous usage telemetry. OFF by default. brain asks once, the first time
// a person runs it in a terminal; agents, scripts and CI are never asked and
// stay off. Opt in any time with `brain telemetry enable`, BRAIN_TELEMETRY=1
// or "telemetry": true in ~/.config/brain/config.json. DO_NOT_TRACK=1 always
// wins.
//
// What an event holds is fixed by `Event` below and nothing else: the command
// name, its outcome, coarse buckets, versions, and a random install id. Never
// a path, a query, a note title, note content, a vault or machine name, or an
// environment variable. `brain telemetry show` prints the queue verbatim.
//
// Sending never touches a command's latency or result: events are appended to
// a local queue, and at most once a day a detached background process posts
// them to PostHog. No collector (BRAIN_POSTHOG_KEY set to "") → nothing is
// sent and the queue stays capped on this machine.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { platform, arch } from "node:os";
import { join } from "node:path";
import { stateRoot } from "./paths.js";
export const TELEMETRY_SCHEMA = "brain.telemetry.v1";
// The collector: PostHog. A project API key ("phc_…") can only send events,
// never read them, and PostHog documents it as safe to publish in client
// code. This is the brain-cli project, US cloud.
export const POSTHOG_KEY = "phc_pbi4HceCUBBVC5GEFQr9JHSPqHkEEdvKocJmuTPMZdbo";
export const POSTHOG_HOST = "https://us.i.posthog.com";
// BRAIN_TELEMETRY_URL points at a custom collector that receives the raw
// brain.telemetry.v1 batch (self-hosting, tests). Otherwise PostHog, when a
// key is set: built in, or BRAIN_POSTHOG_KEY for a fork's own project. Setting
// BRAIN_POSTHOG_KEY to "" turns PostHog off (tests and CI do, so they never
// send to the real project).
export function collector() {
    if (process.env.BRAIN_TELEMETRY_URL)
        return { kind: "custom", url: process.env.BRAIN_TELEMETRY_URL };
    const key = process.env.BRAIN_POSTHOG_KEY ?? POSTHOG_KEY;
    if (!key)
        return null;
    const host = (process.env.BRAIN_POSTHOG_HOST || POSTHOG_HOST).replace(/\/+$/, "");
    return { kind: "posthog", url: `${host}/batch/`, key };
}
// One brain event as a PostHog event. Anonymous by construction: the random
// install id is the distinct id, no person profile is created, GeoIP lookup is
// off, and only the day is sent as the timestamp (noon UTC), never the time.
export function toPostHog(key, events) {
    return {
        api_key: key,
        batch: events.map((e) => {
            const { install, day, schema, ...props } = e;
            return {
                event: "brain_command",
                distinct_id: install,
                timestamp: `${day}T12:00:00Z`,
                properties: {
                    ...props,
                    schema,
                    $process_person_profile: false,
                    $geoip_disable: true,
                    $lib: "brain-cli",
                },
            };
        }),
    };
}
const QUEUE_CAP = 500; // events kept while unsent; oldest dropped first
const FLUSH_EVERY_MS = 24 * 60 * 60 * 1000;
export { stateRoot };
const file = (name) => join(stateRoot(), name);
function readSettings() {
    try {
        const s = JSON.parse(readFileSync(file("telemetry.json"), "utf8"));
        return {
            install: typeof s.install === "string" ? s.install : randomUUID(),
            enabled: typeof s.enabled === "boolean" ? s.enabled : null,
            asked: s.asked === true,
            lastFlush: typeof s.lastFlush === "number" ? s.lastFlush : 0,
        };
    }
    catch {
        return { install: randomUUID(), enabled: null, asked: false, lastFlush: 0 };
    }
}
function writeSettings(s) {
    mkdirSync(stateRoot(), { recursive: true });
    const tmp = file(`telemetry.json.${process.pid}`);
    writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
    renameSync(tmp, file("telemetry.json"));
}
export function status(userConfigTelemetry) {
    const s = readSettings();
    const env = (process.env.BRAIN_TELEMETRY ?? "").toLowerCase();
    const c = collector();
    const collectorLabel = c ? (c.kind === "posthog" ? `PostHog (${new URL(c.url).host})` : c.url) : null;
    const queued = queue().length;
    const off = (reason) => ({ enabled: false, reason, collector: collectorLabel, queued, install: s.install });
    const on = (reason) => ({ enabled: true, reason, collector: collectorLabel, queued, install: s.install });
    if (process.env.DO_NOT_TRACK && process.env.DO_NOT_TRACK !== "0")
        return off("DO_NOT_TRACK is set");
    if (["0", "false", "off", "no"].includes(env))
        return off("BRAIN_TELEMETRY is off");
    if (["1", "true", "on", "yes"].includes(env))
        return on("BRAIN_TELEMETRY is on");
    if (userConfigTelemetry === false)
        return off('"telemetry": false in the user config');
    if (userConfigTelemetry === true)
        return on('"telemetry": true in the user config');
    if (s.enabled === true)
        return on("you opted in");
    if (s.enabled === false)
        return off("you opted out");
    return off("off by default — never opted in");
}
export function setEnabled(enabled) {
    const s = readSettings();
    s.enabled = enabled;
    s.asked = true;
    writeSettings(s);
}
export function resetInstallId() {
    const s = readSettings();
    s.install = randomUUID();
    writeSettings(s);
    return s.install;
}
export function queue() {
    try {
        return readFileSync(file("telemetry-queue.jsonl"), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l));
    }
    catch {
        return [];
    }
}
export function clearQueue() {
    writeFileSync(file("telemetry-queue.jsonl"), "");
}
function bucketMs(ms) {
    return ms < 100 ? "<100" : ms < 500 ? "<500" : ms < 2000 ? "<2000" : ">=2000";
}
function bucketNotes(n) {
    if (n === undefined)
        return null;
    return n === 0 ? "0" : n < 100 ? "<100" : n < 1000 ? "<1k" : n < 10000 ? "<10k" : n < 100000 ? "<100k" : ">=100k";
}
export function buildEvent(install, r, ctx) {
    return {
        schema: TELEMETRY_SCHEMA,
        install,
        day: new Date().toISOString().slice(0, 10),
        command: r.command.replace(/[^a-z.-]/g, "").slice(0, 32) || "unknown",
        exit: r.exit,
        error: r.error ? r.error.replace(/[^a-z_]/g, "").slice(0, 32) : null,
        ms: bucketMs(r.ms),
        notes: bucketNotes(ctx.notes),
        sync: ctx.sync ?? null,
        integrations: ctx.integrations ?? null,
        scoped: ctx.scoped ?? false,
        json: r.json,
        version: r.version,
        node: process.versions.node.split(".")[0] ?? "?",
        os: `${platform()}-${arch()}`,
    };
}
// Called once per command, after it finished. Never throws, never blocks on
// the network, never writes to stdout.
export function record(r, ctx, userConfigTelemetry, binPath) {
    try {
        if (!status(userConfigTelemetry).enabled)
            return;
        const s = readSettings();
        mkdirSync(stateRoot(), { recursive: true });
        appendFileSync(file("telemetry-queue.jsonl"), JSON.stringify(buildEvent(s.install, r, ctx)) + "\n");
        const q = queue();
        if (q.length > QUEUE_CAP) {
            writeFileSync(file("telemetry-queue.jsonl"), q.slice(-QUEUE_CAP).map((e) => JSON.stringify(e)).join("\n") + "\n");
        }
        const due = Date.now() - s.lastFlush > FLUSH_EVERY_MS;
        if (due && collector() && existsSync(binPath)) {
            s.lastFlush = Date.now();
            const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", binPath, "telemetry", "flush"], {
                detached: true,
                stdio: "ignore",
                env: { ...process.env },
            });
            child.unref();
        }
        writeSettings(s);
    }
    catch {
        // Telemetry must never affect a command.
    }
}
// Post the queue to the collector; on success, clear it. Runs in the detached
// background process, or by hand.
export async function flush() {
    const c = collector();
    const events = queue();
    if (!c)
        return { sent: 0, error: "no collector configured (no PostHog project key yet)" };
    if (!events.length)
        return { sent: 0, error: null };
    try {
        const body = c.kind === "posthog" ? toPostHog(c.key, events) : { schema: TELEMETRY_SCHEMA, events };
        const res = await fetch(c.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok)
            return { sent: 0, error: `collector answered ${res.status}` };
        clearQueue();
        return { sent: events.length, error: null };
    }
    catch (err) {
        return { sent: 0, error: err.message };
    }
}
// Whether to show the one-time question: only to a person at a terminal who
// has not decided by any route, and never in --json mode, CI, or a hook.
export function shouldAsk(opts) {
    const tty = opts.tty ?? (process.stdin.isTTY === true && process.stderr.isTTY === true);
    if (!tty || opts.json || process.env.CI)
        return false;
    // setup asks the same question itself, as one of its steps.
    if (["telemetry", "help", "context", "setup", "unknown"].includes(opts.command.split(".")[0]))
        return false;
    if (process.env.DO_NOT_TRACK || process.env.BRAIN_TELEMETRY || typeof opts.userConfigTelemetry === "boolean")
        return false;
    const s = readSettings();
    return !s.asked && s.enabled === null;
}
export function parseAnswer(answer) {
    return /^\s*(y|yes)\s*$/i.test(answer);
}
// Ask once, on stderr. No answer within a minute, or anything but yes, is no.
export async function ask() {
    process.stderr.write("\nHelp improve brain? Share anonymous usage data: command names, outcomes and versions —\n" +
        "never paths, queries, note titles or content. Details: docs/telemetry.md.\n" +
        "Change your mind any time: brain telemetry enable | disable.\n");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(""), 60_000);
        rl.question("Share anonymous usage data? [y/N] ", (a) => {
            clearTimeout(timer);
            resolve(a);
        });
    });
    rl.close();
    const yes = parseAnswer(answer);
    setEnabled(yes);
    process.stderr.write(yes ? "Thanks — telemetry is on.\n\n" : "Telemetry stays off.\n\n");
    return yes;
}
