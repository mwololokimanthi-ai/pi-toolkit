---
description: Deliver a Task Prompt to an APM Worker.
argument-hint: "[agent-id]"
---

# APM 1.0.1 - Worker Check Tasks Command

Check your Task Bus for pending Task Prompts. If you are a Planner, Manager, or non-APM agent, concisely decline and take no action. This command replaces manual file referencing - you resolve your bus path from your registered identity or from the provided `[agent-id]` argument. This is also the procedure followed when the Manager's coms Task Bus notification wakes the session (per your standing instructions) - the notification points at the Task Bus, and this procedure reads and processes it. Run it manually any time to catch up if a notification was missed.

Accepts an optional `[agent-id]` argument. If registered, ignore it (bus path already known). If not registered, the argument is required to resolve identity.

**Procedure:**
1. Determine registration state:
   - If registered, resolve bus path from registration. Continue to step 3.
   - If not registered, `$ARGUMENTS` is required. If no argument provided, inform User that an agent-id is required.

2. Resolve agent-id (unregistered Workers only): resolve `$ARGUMENTS` against `.apm/bus/` directory names per `<pi-home>/skills/apm-communication/SKILL.md` §4.2 Agent ID Resolution. Initialize per `<pi-home>/prompts/apm-3-initiate-worker.md` §2 Initiation.

3. Read Task Bus at `.apm/bus/<agent-slug>/task.md`.
   - If empty, inform User that no pending Task is available. Await next invocation.
   - If content present, continue to step 4.

4. Cross-validate `agent` field in YAML frontmatter against registered identity. Mismatch flags a routing error - decline and direct User to the correct Worker. Process the Task per `<pi-home>/apm-guides/task-execution.md` §3 Task Execution Procedure.

---

**End of Command**
