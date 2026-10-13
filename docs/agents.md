# Teaching agents to use brain

An agent has to know brain exists before it can call it. `brain agent install` sets that
up per harness, in two layers:

- **A skill** (`skills/brain/SKILL.md`, the [Agent Skills](https://agentskills.io) format).
  Only its one-paragraph description sits in the agent's context; the full instructions
  load when a question matches — "what did I decide about…", "do I have notes on…". It
  costs almost nothing until it is needed.
- **A primer at session start** from `brain context`: what brain is, plus the five most
  recent memory titles, so the agent starts each session knowing what it knows.

| Harness | `brain agent install …` | Skill | Session primer |
| --- | --- | --- | --- |
| Claude Code | `claude` | `~/.claude/skills/brain/` | a `SessionStart` hook running `brain context` — printed for you to paste into `~/.claude/settings.json`; brain never edits your settings |
| [Pi](https://pi.dev) | `pi` | `~/.agents/skills/brain/` (Pi reads it; not also `~/.pi/agent/skills`, which would collide) | `~/.pi/agent/extensions/brain-memory.ts`, injecting once per session — Pi persists injected messages, so once is the only safe cadence |
| Others | `agents` | `~/.agents/skills/brain/`, for harnesses that read the Agent Skills shared location | add `brain context` to the harness's own startup hook |

`brain context` prints nothing and exits 0 when there is no vault, so a hook can never
break the agent that runs it. The installer refuses to replace a file it did not write
(`--force` to override) and `--dry-run` shows what it would do.

The Pi integration is checked end to end in CI: [`scripts/verify-pi.sh`](../scripts/verify-pi.sh)
runs a real Pi against a fake local model and asserts that the request lists the skill and
carries exactly one primer on the first turn and on the second.

For a harness without skills or hooks, one line in its always-loaded instructions works:

```markdown
For questions about my notes or past decisions, run `brain search "<question>" --json` first;
use grep only for exact strings.
```
