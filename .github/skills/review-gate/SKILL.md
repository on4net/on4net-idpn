---
name: review-gate
description: "The on4net IDPN review gate — the mandatory checklist a task must pass before it is marked Done. Use when reviewing a completed task, deciding whether to mark Done, or reporting task completion. Covers DoD completeness, tests, code review, security, docs, and project fields."
user-invocable: true
---

# Review Gate (on4net IDPN)

A task is marked **Done only after the review gate passes**. Never claim completion while the gate cannot pass.

## When to Use
- Before reporting a task complete.
- Before moving a Project #2 item to `Done`.
- When reviewing a PR or a completed phase task.

## The Gate — all steps must pass

### 1. Issue & DoD completeness
- No open sub-task or dependency that blocks the task.
- Every acceptance criterion in the issue is met and checked (`- [x]`), not just described.
- If the issue has no checklist, verify against `docs/` and state the evidence.

### 2. Test gate
- Unit + Integration for the touched area; E2E when a user flow changed.
- Lint, typecheck and build pass.
- OIDC/RBAC/social negative cases covered where relevant.
- MFE changes: RTL, axe, style isolation and Portal tests pass.
- See `docs/testing.md` for the test matrix and coverage gates.

### 3. Code review
- Change is minimal, matches existing conventions and architecture.
- Callers updated; no dead code; types consistent.
- Migrations are safe and reversible.
- MFE: CSS/Preflight does not leak, Portal container is inside the MFE root.

### 4. Security review
- No secrets/keys/tokens in code or committed files.
- Auth/RBAC enforced server-side; no client-only checks.
- Client scoping: `clientId` matches token; no cross-client access.
- Input validation, CSRF, rate limits and audit events where required.
- OIDC: PKCE, state/nonce, exact redirect URI, code reuse and refresh reuse rejected.
- Social: per-client credentials, verified email, state bound to client/provider.
- Dependency and supply-chain checks pass.

### 5. Docs consistency
- `docs/api.md` updated for API/contract changes.
- `docs/domain-model.md` updated for schema/claims changes.
- `docs/design-system.md` updated for UI/token/RTL changes.
- `docs/testing.md` updated for new test coverage.
- `docs/roadmap.md` reflects phase state when relevant.

### 6. Project fields
- Issue linked to the correct Epic and phase label.
- Status moved to `In review`, then `Done` only after the gate passes.
- Size/Priority labels are correct.
- Completion summary includes tests run and evidence.

## Output
- Gate verdict: PASS / FAIL
- Which step failed (if any) and what is needed
- Commands/tests run with results
- Docs and project fields updated