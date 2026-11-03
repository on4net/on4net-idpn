---
name: git-workflow
description: 'Handle the Git workflow for on4net/on4net-idpn: status, diff, branch, commit, push, and verify changes. Use when asked to commit, stage, branch, push, check status/diff, or review what changed. Never force push, never discard user changes, never commit unrelated changes, never commit secrets.'
argument-hint: 'Git action: status, diff, branch, commit, push, or verify...'
---

# on4net IDPN Git Workflow

Handle Git operations for the on4net IDPN repository safely.

## When to Use
- The user asks to commit, push, create a branch, check status/diff, or verify what changed.
- You are about to modify files and need to understand the current state.

## Repositories
- `on4net-idpn/` — https://github.com/on4net/on4net-idpn (default: main)

The repository holds `api/` (NestJS + Fastify), `web/` (React 19 + Vite + shadcn/ui), `docs/`, and `.github/` (skills and agents).

## Hard Rules
- NEVER force push (`--force` / `--force-with-lease` is still force).
- NEVER discard user changes (`git checkout .`, `git reset --hard`, deleting untracked files) without explicit permission.
- NEVER commit unrelated changes — only stage what belongs to the task.
- NEVER commit secrets, keys, tokens, or credentials. Check the diff for secrets first.
- Always inspect `git status` and `git diff` before committing.

## Procedure
1. **Status** — run `git status` to see the working tree.
2. **Diff** — review `git diff` (staged and unstaged) so you know exactly what will change.
3. **Branch** — confirm the correct branch; create a feature branch if the task warrants one.
4. **Stage** — stage only the files relevant to the task.
5. **Commit** — write a clear, conventional commit message describing the change.
6. **Verify** — review the staged diff once more (secrets check) before commit.
7. **Push** — push to the remote (normal push only).
8. **Report** — summarize what was committed, the commit hash, and the branch.

## Output Format
- Repo and branch
- Files staged/committed
- Commit message
- Verification performed (diff/secrets check)
- Push result
