---
description: Agent-Reach channel health and repair — doctor / verify-all / repair
argument-hint: "[doctor | verify-all | repair <channel>]"
---
Use the `agent-reach` skill: read ~/.pi/agent/skills/agent-reach/SKILL.md first — it holds the machine state, retry chains, and per-platform command groups — then read the matching references/ doc for the channels involved.

Requested action: ${@:-doctor}

Interpretation:
- `doctor` (default): run `agent-reach doctor --json` for all 16 channels plus the pi tool `agent_reach_status`. Report which backend serves each channel right now, and flag anything that contradicts the skill's "Machine state" section (stale state, dead OpenCLI bridge, expired browser session, missing binary).
- `verify-all`: live-verify every channel with ONE read-only real query each. Space calls 2–3 s apart. Stop and ask the user at the first CAPTCHA, risk code, or repeated 429 — do not hammer. Report a table: channel | backend | verdict | one-line evidence.
- `repair <channel>`: run that channel's retry chain from the skill's references/ docs, step by step. Say what you are using (platform / backend) at each step, and report what changed.

Rules:
- Read-only verification only — no posts, follows, likes, or logins on the user's behalf.
- If a fix requires user action (login, QR scan, cookie export, loading an extension), stop and state exactly what the user must do.
- Update the skill's "Machine state" section afterwards if the verified state has changed, then commit + push ~/.pi/agent per the git-safe-workflow skill.
