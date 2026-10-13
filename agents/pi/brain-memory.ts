// Pi extension: tell the agent about the user's brain vault once per session.
//
// Installed by `brain agent install pi` into ~/.pi/agent/extensions/.
// It runs `brain context` and adds the output as a hidden message before the
// first user prompt of a session. Once per session, on purpose: a message
// returned from before_agent_start is persisted in the session, so injecting
// it every turn would stack stale copies in the context.
//
// If brain is missing, no vault is configured, or it is slow, this does
// nothing — an absent memory must never break the agent.

import { execFile } from "node:child_process";

// Pi passes its ExtensionAPI; typed loosely so this file has no build-time
// dependency on Pi's package.
export default function brainMemory(pi: any) {
  let injected = false;

  pi.on("session_start", () => {
    injected = false;
  });

  pi.on("before_agent_start", async (event: any) => {
    if (injected || event?.messageType === "custom") return undefined;
    injected = true;
    const context = await brainContext();
    if (!context) return undefined;
    return { message: { customType: "brain-memory", content: context, display: false } };
  });
}

function brainContext(): Promise<string> {
  return new Promise((resolve) => {
    execFile(process.env.BRAIN_BIN || "brain", ["context"], { timeout: 3000 }, (err, stdout) => {
      resolve(err ? "" : String(stdout).trim());
    });
  });
}
