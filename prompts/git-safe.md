---
description: Git-safe GitHub workflow — checkpoint, commit + push, review, or rollback
argument-hint: "[checkpoint|review|push|rollback]"
---
Run the `git-safe-workflow` skill (read ~/.pi/agent/skills/git-safe-workflow/SKILL.md first if you haven't this session) for the current project folder. Action requested: `${1:-full}`.

- `full` (default): ensure the project folder is a git repo with a GitHub remote under `mwololokimanthi-ai` (if not: `git init`, add `.gitignore` if missing, baseline commit, `gh repo create <folder-name> --private --source . --remote origin --push`); commit any uncommitted work with a clear imperative message (never .env/secrets); if the tree is clean afterward, refresh the rollback checkpoint (`git tag -d good-latest 2>/dev/null; git tag good-latest; git push origin good-latest --force`); push to main; then give the standard closeout: `git log --oneline -5`, links (commits page, last commit diff, compare `good-latest...main`), and the rollback command table.
- `checkpoint`: commit WIP, refresh + push the `good-latest` tag, stop (no feature commits).
- `review`: commit nothing. Show `git log --oneline -10`, `git diff good-latest..HEAD --stat`, and the GitHub review links (commits, last commit, compare page).
- `rollback`: first show `git diff good-latest..HEAD --stat` so the user sees what will be undone; then, unless the user named a specific commit (`git revert <sha> && git push`), run `git reset --hard good-latest && git push --force-with-lease` and confirm the final `git log --oneline -3`.
- `push`: commit + push current changes only (no checkpoint, no review table beyond the commit link).

If git or `gh` auth is broken, fix it (or ask the user) before reporting done. End with the standard closeout from the skill.
