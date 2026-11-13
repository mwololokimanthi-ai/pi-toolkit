---
name: git-safe-workflow
description: Commit and push created/changed code to the user's GitHub with rollback checkpoints. Use whenever code files are created or modified in a project, or when the user asks to commit, push, review changes, or revert/roll back.
---

# Git Safe Workflow

Goal: every piece of code the agent creates ends up on the user's GitHub (account: `mwololokimanthi-ai`, auth via SSH) with a clear rollback point, and the user always gets review links + rollback commands at the end of the work.

Tools: `git` (global config already set: mwololokimanthi-ai / noreply email, default branch `main`), `gh` CLI at `~/.pi/agent/bin/gh` (device-authenticated).

Companion pieces:
- **`/git-safe`** prompt template (`~/.pi/agent/prompts/git-safe.md`) — user-invokable slash command with actions `checkpoint | review | push | rollback` (default: full flow).
- **`git-reminder`** extension (`~/.pi/agent/extensions/git-reminder/index.ts`) — auto-reminds at turn end when there are uncommitted/unpushed changes, or code sitting in a folder with no repo. Rate-limited (5 min/project), silent for 30 min after a successful push.

## Creating new skills / extensions / prompts (labeling + auto-push rules)

- **Folder = label.** Every new skill lives in its own folder: `~/.pi/agent/skills/<skill-name>/SKILL.md`. Every new extension lives in its own labeled folder: `~/.pi/agent/extensions/<name>/index.ts` — never loose `.ts` files at the extensions root. Prompts: `~/.pi/agent/prompts/<name>.md`.
- **Push when created.** `~/.pi/agent` is itself a git repo (GitHub: `mwololokimanthi-ai/pi-agent-config`, allowlisted via `.gitignore` so secrets like `auth.json`/`settings.json` are never pushed). After creating or modifying any skill, extension, prompt, agent definition, or `CLAUDE.md`: commit with a clear message and push to `main` there (same checkpoint/tag flow as normal projects: refresh `good-latest` before, push after, closeout at the end).

## 1. Ensure the project has a repo (once per CODE project folder)

**Scope — when a repo is required:** only for folders that hold, or are expected to hold, **code** — source files, scripts, notebooks, extensions, skills, or prompts.

**Scope — when to skip:** research-only folders. Searches, transcripts, fetched articles, reports, scratch data — if no code is expected there, do **not** `git init`, do **not** `gh repo create`, do **not** add a `.gitignore`, and do **not** flag it as a missing repo in the closeout. Leave the folder unversioned.

**Look forward, not just at today's contents.** If the project's plan, spec, roadmap, README, or the user indicates that code will eventually be written for it, it is a code project **now** — create the repo at the research stage so the notes are backed up alongside the code that follows, rather than waiting for the first line of code. If the research is a subfolder of a planned-code project, the repo belongs on the project root that will hold the code. Only when nothing indicates future code does the folder stay unversioned; if code unexpectedly appears later, start this section at that point.

**Judgement is on the folder's purpose, not the file extensions in it.** A stray `.py` in a research folder does not make it a code project — and a code-shaped folder is not exempt just because it is empty today.

**A project-level VC policy beats these defaults.** If the project's own `CLAUDE.md` records one — e.g. an `APM_RULES` block with `Remote pushes: disabled` — follow it: skip the push, skip the `good-latest` tag push, and don't report missing GitHub links in the closeout.

Steps below apply to a code project only:
- Work in the **project folder itself** — never init a repo for `/workspace` or any parent directory.
- If the folder is not a git repo: `git init`, then add a stack-appropriate `.gitignore` if missing (`node_modules/`, `__pycache__/`, `.env`, `dist/`, `venv/`, `*.pyc`, etc.).
- Commit any pre-existing files first: `git add -A && git commit -m "chore: baseline before agent changes"`.
- Create the GitHub repo and push (repo name = folder name):
  ```
  gh repo create <folder-name> --private --source . --remote origin --push
  ```
- If `gh auth status` fails, ask the user to re-auth (`gh auth login`) or to create the repo manually at https://github.com/new, then `git remote add origin git@github.com:mwololokimanthi-ai/<folder-name>.git && git push -u origin main`.

## 2. Before making changes — rollback checkpoint

1. Commit & push any uncommitted work first (the user's WIP belongs in history too).
2. If the tree is clean, refresh the rolling checkpoint tag:
   ```
   git tag -d good-latest 2>/dev/null
   git tag good-latest
   git push origin good-latest --force
   ```
   Always exactly one tag named `good-latest` = last known-good state.

## 3. After changes — commit + push

- `git add -A` — never stage `.env`, secrets, credentials, or large binaries.
- Commit message: short imperative summary, e.g. `feat: add login form with validation`, `fix: handle empty config file`.
- `git push` (branch is `main`).

## 4. Mandatory closeout — review + rollback guide

After every push, include in the final message:

- Recent history (`git log --oneline -5`).
- Links (replace `<repo>`, `<sha>`):
  - All commits: `https://github.com/mwololokimanthi-ai/<repo>/commits/main`
  - Last commit diff: `https://github.com/mwololokimanthi-ai/<repo>/commit/<sha>`
  - Compare since last good state: `https://github.com/mwololokimanthi-ai/<repo>/compare/good-latest...main` (local: `git diff good-latest..HEAD`)
- Rollback options:
  | Situation | Command |
  |---|---|
  | Undo the last commit, keep history | `git revert HEAD && git push` |
  | Undo one specific commit | `git revert <sha> && git push` |
  | Back out ALL changes to last good state | `git reset --hard good-latest && git push --force-with-lease` |
  | No CLI (browser) | Open the commit page on GitHub → **Revert** button |
- If something broke: start with `git diff good-latest..HEAD --stat` to see exactly what changed, then pick a rollback.

## Rules

- Never rewrite published branch history unless the user explicitly asked to roll back. `--force-with-lease` is allowed only on the `good-latest` tag or for an explicit `reset --hard` rollback request.
- Never commit secrets, keys, or tokens — check `git status` output before committing.
- Keep commits granular: one logical change per commit when doing multi-step work.
