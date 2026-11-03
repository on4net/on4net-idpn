---
name: github-task-management
description: 'Manage on4net IDPN GitHub tasks in on4net/on4net-idpn and Project 2. Use when creating, triaging, assigning, or mapping issues, epics, spikes, phases, or feature work for the identity provider project.'
argument-hint: 'Task, issue, epic, or feature to create/triage...'
---

# on4net IDPN GitHub Task Management

Manage GitHub tasks for the on4net IDPN identity provider.

## Project Mapping

| Area | Repository | GitHub Project |
|---|---|---|
| on4net IDPN (all phases) | `on4net/on4net-idpn` | Project 2 |

- One Epic per phase; implementation tasks use labels `phase:0` … `phase:6`.
- Area labels: `backend`, `frontend`, `mfe`, `security`, `testing`, `devops`, `docs`, `social`, `rbac`, `design-system`, `shadcn`, `a11y`.
- Priority labels: `P0`, `P1`, `P2`.
- Phase 0 tasks are `Ready`; later phases start as `Backlog`.

## When to Use
- Creating, updating, or triaging issues/tasks.
- Assigning a task to the correct phase, area, or epic.
- The user says "create a task", "file an issue", "add this to the project", or "where does this task belong".

## Procedure
1. Determine the phase and area:
   - Phase 0: foundation, infra, schema, test harness, design system bootstrap
   - Phase 1: OIDC core, hosted login, token/session
   - Phase 2: management, RBAC, memberships, delegated admin
   - Phase 3: SSO, logout, sessions, key rotation
   - Phase 4: per-client social login, MFA, account lifecycle
   - Phase 5: app integration and user migration
   - Phase 6: hardening, performance, release
2. Inspect fields and items before editing (never guess IDs):
   - `gh project field-list 2 --owner on4net`
   - `gh project item-list 2 --owner on4net --format json`
3. Create the issue in `on4net/on4net-idpn` with `gh issue create -R on4net/on4net-idpn --title ... --body-file ... --label ...`.
4. Add it to the project:
   - `gh project item-add 2 --owner on4net --url <issue-url> --format json`
5. Set fields using IDs from `field-list`:
   - `gh project item-edit --project-id PVT_kwDOEVue5c4Bnjku --id <itemID> --field-id <fieldID> --single-select-option-id <optionID>`
6. Use clear titles and bodies:
   - Epic: `[Epic] Phase N — ...`
   - Spike: `[Spike] ...`
   - Task: imperative title, Persian body with `هدف`، `تحویل‌شدنی‌ها`، `معیار پذیرش`، `Epic: #N`.
7. Prefer the `gh` CLI authenticated with the `project` scope for this organization.

## Output Format
- Task title and description
- Repository where created
- Project/phase it was added to
- Link to the issue/task
- Notes on dependencies or follow-up tasks