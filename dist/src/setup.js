// `brain setup`: the first-run walkthrough. Every step is a choice the person
// makes; nothing is written until they approve the summary. It writes only
// this machine's config (and, if they say yes, one line in their shell
// profile) — never the vault, never another tool's settings.
//
// Interactive in a terminal; `--yes` plus flags for agents and scripts.
import { existsSync, readdirSync, readFileSync, appendFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { install, HARNESSES } from "./agent.js";
import { readUserConfig, slug, writeUserConfig } from "./config.js";
import { isGitRepo } from "./sync.js";
import * as telemetry from "./telemetry.js";
const CLOUD = /\/Library\/Mobile Documents\/|\/Library\/CloudStorage\/|\/Dropbox\/|\/OneDrive\//;
// Folders that look like vaults: an .obsidian/ or brain.json inside, found in
// the usual places. Shallow on purpose: setup should be instant.
export function findVaultCandidates(cwd = process.cwd(), home = homedir()) {
    const out = new Set();
    const isVault = (d) => existsSync(join(d, ".obsidian")) || existsSync(join(d, "brain.json"));
    let d = resolve(cwd);
    for (;;) {
        if (isVault(d))
            out.add(d);
        const up = resolve(d, "..");
        if (up === d)
            break;
        d = up;
    }
    const roots = [
        join(home, "Library", "Mobile Documents", "iCloud~md~obsidian", "Documents"),
        join(home, "Documents"),
        join(home, "Obsidian"),
        join(home, "Dropbox"),
        home,
    ];
    for (const root of roots) {
        let entries = [];
        try {
            entries = readdirSync(root);
        }
        catch {
            continue;
        }
        for (const name of entries) {
            if (name.startsWith("."))
                continue;
            const dir = join(root, name);
            try {
                if (isVault(dir))
                    out.add(dir);
            }
            catch {
                // unreadable: skip
            }
        }
    }
    if (process.env.BRAIN_VAULT)
        out.add(resolve(process.env.BRAIN_VAULT));
    return [...out];
}
export function recommendSync(vault) {
    const cloud = CLOUD.test(vault + "/");
    const git = isGitRepo(vault);
    if (cloud && git) {
        return {
            mode: "none",
            why: "the vault is in a cloud-synced folder, which already moves the files between machines",
            warning: "this vault is also a git repository inside a cloud folder; two sync systems on one folder can corrupt .git. " +
                "Keep git for history from one machine only, or move the clone out of the cloud folder.",
        };
    }
    if (cloud)
        return { mode: "none", why: "the vault is in a cloud-synced folder, which moves the files", warning: null };
    if (git)
        return { mode: "git", why: "the vault is a git repository", warning: null };
    return { mode: "none", why: "no git repository and no cloud folder detected; brain will not move files", warning: null };
}
export function detectHarnesses(home = homedir()) {
    const found = [];
    if (existsSync(join(home, ".claude")))
        found.push("claude");
    if (existsSync(join(home, ".pi")))
        found.push("pi");
    if (existsSync(join(home, ".agents")))
        found.push("agents");
    return found;
}
export function profileFile(home = homedir(), shell = process.env.SHELL ?? "") {
    const name = basename(shell);
    if (name === "zsh")
        return join(home, ".zshrc");
    if (name === "fish")
        return join(home, ".config", "fish", "config.fish");
    if (name === "bash")
        return join(home, process.platform === "darwin" ? ".bash_profile" : ".bashrc");
    return join(home, ".profile");
}
export function profileLine(vault, file) {
    const quoted = `"${vault.replace(/(["\\$`])/g, "\\$1")}"`;
    return file.endsWith("config.fish") ? `set -gx BRAIN_VAULT ${quoted}` : `export BRAIN_VAULT=${quoted}`;
}
// Apply approved choices. Separate from asking, so `--yes` and the
// interactive path write exactly the same things.
export function applySetup(c, opts = {}) {
    const configPath = writeUserConfig({ machine: c.machine, sync: c.sync, vault: c.vault });
    const installs = c.agents.map((h) => install(h, { home: opts.home }));
    if (c.telemetry !== null)
        telemetry.setEnabled(c.telemetry);
    if (c.updateCheck !== null)
        writeUserConfig({ updates: { ...objectOr(readUserConfig().updates), check: c.updateCheck } });
    let profile = null;
    if (c.profile) {
        const file = profileFile(opts.home);
        const line = profileLine(c.vault, file);
        const current = existsSync(file) ? readFileSync(file, "utf8") : "";
        const added = !current.includes(line);
        if (added)
            appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}\n# brain-cli\n${line}\n`);
        profile = { file, line, added };
    }
    return { choices: c, configPath, installs, profile };
}
// ---- interactive -----------------------------------------------------------
function q(rl, prompt) {
    return new Promise((r) => rl.question(prompt, (a) => r(a.trim())));
}
async function pick(rl, label, options, def) {
    process.stderr.write(`\n${label}\n`);
    options.forEach((o, i) => process.stderr.write(`  ${i + 1}) ${o.label}${i === def ? "  (recommended)" : ""}\n`));
    for (;;) {
        const a = await q(rl, `Choose 1-${options.length} [${def + 1}]: `);
        if (!a)
            return options[def].value;
        const n = Number(a);
        if (Number.isInteger(n) && n >= 1 && n <= options.length)
            return options[n - 1].value;
    }
}
async function yesNo(rl, prompt, def) {
    const a = (await q(rl, `${prompt} [${def ? "Y/n" : "y/N"}] `)).toLowerCase();
    return a ? a === "y" || a === "yes" : def;
}
export async function interactiveSetup() {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        process.stderr.write("brain setup — a few choices for this machine. Nothing is written until you confirm.\n");
        // 1. vault
        const candidates = findVaultCandidates();
        const OTHER = "\u0000other";
        let vault;
        if (candidates.length) {
            const v = await pick(rl, "1. Which vault should brain use?", [...candidates.map((c) => ({ value: c, label: c.replace(homedir(), "~") })), { value: OTHER, label: "another folder…" }], 0);
            vault = v === OTHER ? resolve((await q(rl, "Path to the vault: ")).replace(/^~/, homedir())) : v;
        }
        else {
            process.stderr.write("\n1. No vault found nearby.\n");
            vault = resolve((await q(rl, "Path to the vault: ")).replace(/^~/, homedir()));
        }
        if (!existsSync(vault)) {
            process.stderr.write(`${vault} does not exist. Nothing was written.\n`);
            return null;
        }
        // 2. machine
        const defMachine = slug(String(readUserConfig().machine ?? "") || hostname().replace(/\.local$/i, ""));
        process.stderr.write("\n2. A short name for this machine (it labels the memory entries written here).\n");
        const machine = slug((await q(rl, `Machine name [${defMachine}]: `)) || defMachine) || defMachine;
        // 3. sync
        const rec = recommendSync(vault);
        if (rec.warning)
            process.stderr.write(`\n⚠ ${rec.warning}\n`);
        const sync = await pick(rl, `3. How does this vault reach your other machines? (recommended because ${rec.why})`, [
            { value: "none", label: "Something else moves the files (iCloud, Dropbox, Syncthing, Obsidian Sync)" },
            { value: "git", label: "git — brain commits new entries, pulls and pushes" },
            { value: "auto", label: "auto — git if the vault is a git repository, otherwise none" },
        ], rec.mode === "git" ? 1 : 0);
        // 4. agents
        const detected = detectHarnesses();
        process.stderr.write(`\n4. Teach your agents about brain (installs the brain skill${detected.length ? `; found: ${detected.join(", ")}` : ""}).\n`);
        const agents = [];
        for (const h of HARNESSES) {
            const label = h === "claude" ? "Claude Code" : h === "pi" ? "Pi" : "other agents (~/.agents/skills)";
            if (await yesNo(rl, `   ${label}?`, detected.includes(h)))
                agents.push(h);
        }
        // 5. telemetry
        const st = telemetry.status(readUserConfig().telemetry);
        let tel = null;
        process.stderr.write("\n5. Share anonymous usage data? Command names, outcomes and versions — never paths, queries,\n" +
            "   note titles or content (docs/telemetry.md). Change it any time with brain telemetry.\n");
        tel = await yesNo(rl, `   Share?${st.enabled ? " (currently on)" : ""}`, st.enabled);
        // 6. update check
        process.stderr.write("\n6. Check GitHub once a day for a newer brain? It sends nothing but the request, and only\n" +
            "   tells you in a terminal (docs/updates.md). Turn it off any time: BRAIN_NO_UPDATE_CHECK=1.\n");
        const updateCheck = await yesNo(rl, "   Check?", objectOr(readUserConfig().updates).check !== false);
        // 7. shell profile
        const pfile = profileFile();
        process.stderr.write(`\n7. Let every shell (and the agents started from it) find this vault:\n   ${profileLine(vault, pfile)}\n`);
        const profile = await yesNo(rl, `   Add that line to ${pfile.replace(homedir(), "~")}?`, false);
        // review
        const choices = { vault, machine, sync, agents, telemetry: tel, updateCheck, profile };
        process.stderr.write([
            "",
            "Review:",
            `  vault      ${vault.replace(homedir(), "~")}`,
            `  machine    ${machine}`,
            `  sync       ${sync}`,
            `  agents     ${agents.length ? agents.join(", ") : "none"}`,
            `  telemetry  ${tel ? "on" : "off"}`,
            `  updates    ${updateCheck ? "check daily" : "do not check"}`,
            `  profile    ${profile ? `add BRAIN_VAULT to ${pfile.replace(homedir(), "~")}` : "leave unchanged"}`,
            "",
        ].join("\n") + "\n");
        return (await yesNo(rl, "Write these settings?", true)) ? choices : null;
    }
    finally {
        rl.close();
    }
}
function objectOr(v) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
