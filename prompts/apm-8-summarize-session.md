---
description: Summarize and optionally archive an APM session.
---

# APM 1.0.1 - Summarize Session Command

This command summarizes the current APM session and optionally archives it. You are a standalone agent - not a Planner, Manager, or Worker. If you are one of those roles, concisely decline and take no action.

**Procedure:**
1. Read the following artifacts directly (these reads are independent):
   - `.apm/spec.md` - design decisions and constraints
   - `.apm/plan.md` - Stages, Tasks, agent assignments
   - `.apm/tracker.md` - Task statuses, Worker states, working notes
   - `.apm/memory/index.md` - Memory notes and Stage summaries
   If working notes or Stage summaries reference specific Task Logs for claims or findings that need verification, read those logs directly. Do not read all Task Logs - comprehensive log review is handled by the subagent in step 2.
2. Spawn a dedicated scout subagent - it runs in its own context window and returns findings when complete: `subagent({agent: "scout", task: "..."})`. Prompt it to read all `.apm/` artifacts including Task Logs in `.apm/memory/` and cross-validate against the current codebase. The subagent verifies that deliverables exist, commits are on the expected branches, and key validation results hold. It reports back: per-Stage outcomes with log-level detail, codebase staleness relative to `.apm/` state, and notable findings from execution.
3. Write `.apm/session-summary.md` per the session summary structure below. The summary is a point-in-time snapshot - state this explicitly.
4. Present the summary to the User. Ask if there is anything to add, correct, or emphasize before finalizing. If the User provides input, update the summary accordingly.
5. Ask: "Would you like me to archive this session?" If yes, ask whether the User wants a custom archive name or the default dated name.
   - If the User declines, no further action.
   - If the User approves, continue to step 6.
6. Perform the archive snapshot with shell commands in the project directory. First determine the archive name: the custom name if the User provided one, otherwise `session-<YYYY-MM-DD>-<NNN>` - current UTC date, and the next free 3-digit sequence number after existing `.apm/archives/session-*` directories (001 if none). Then:
   - Create the archive directory: `mkdir -p .apm/archives/<name>`
   - Copy everything in `.apm/` except `archives/` into it: `for e in .apm/*; do b=$(basename "$e"); [ "$b" = "archives" ] || cp -r "$e" ".apm/archives/<name>/"; done`
   - Remove the originals from the `.apm/` root (keep `archives/`): `for e in .apm/*; do b=$(basename "$e"); [ "$b" = "archives" ] || rm -rf "$e"; done`
   - Write archival metadata: `printf '{\n  "archivedAt": "%s",\n  "reason": "archive"\n}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .apm/archives/<name>/metadata.json`
   This leaves `.apm/` clean for a new session while preserving all archives.
7. Read `.apm/archives/index.md`. If it does not exist or is malformed, create it per the archive index format below.
8. Append an entry for the newly archived session to the index table.
9. Confirm to the User that archival is complete. To start a new APM session, the User opens a new terminal in the project directory, starts a new pi session, and runs `/apm-1-initiate-planner` - the Planner bootstraps a fresh `.apm/` directory from the bundled seed templates (see its §4 Work Breakdown Procedure); no CLI init step is needed. Archives from previous sessions remain in `.apm/archives/` and are accessible to the new Planner during Context Gathering.

**Session summary structure:**

*Location:* `.apm/session-summary.md`

*YAML frontmatter schema:*
```yaml
---
date: <YYYY-MM-DDTHH:MM:SSZ>
project: <project name>
stages_completed: <number>
total_tasks: <number>
outcome: <complete | partial | incomplete>
---
```

*Field descriptions:*
- `date`: string, required, ISO 8601 datetime of summary creation (includes date and time).
- `project`: string, required, project name from the Spec.
- `stages_completed`: integer, required, number of completed Stages.
- `total_tasks`: integer, required, total Tasks across all Stages.
- `outcome`: enum, required, derived from session state. `complete` when the Tracker's YAML frontmatter contains `completed_at` (Manager has authoritatively confirmed). `partial` when `stages_completed >= 1` (at least one Stage finished). `incomplete` when `stages_completed == 0` (no Stages finished).

*Body sections* (order as listed):
- *Project Scope:* What was being built and why, from the Spec.
- *Stages and Outcomes.* Per-Stage summary: objective, Tasks completed, notable results.
- *Key Deliverables:* Primary outputs with file paths or descriptions.
- *Codebase State.* Compare the actual codebase against the planning artifacts: which planned deliverables exist as code, which are partial or missing, whether the code evolved past what the Spec and Plan describe, and any gaps between what was planned and what was implemented.
- *Notable Findings:* Operational lessons and patterns - issues encountered and how they were resolved, self-corrections during execution, recovery events, coordination insights. Draw from Memory notes, working notes, and Task Logs.
- *Known Issues:* Unresolved problems, open questions, or caveats.
- *Snapshot Notice:* "This summary reflects the session state as of `<datetime>`. The codebase may have diverged since this summary was created."

**Archive index format:**

*Location:* `.apm/archives/index.md`

```markdown
# APM Archive Index

| Archive | Date | Scope | Stages | Tasks |
|---------|------|-------|--------|-------|
```

*Field descriptions:*
- *Archive:* directory name (e.g., `session-2026-03-04-001`).
- *Date:* ISO date of archival.
- *Scope:* brief project description (from session summary or Spec title).
- *Stages:* number of completed Stages.
- *Tasks:* total Tasks.

Newest entries go at the top of the table.

---

**End of Command**
