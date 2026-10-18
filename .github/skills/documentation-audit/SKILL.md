---
name: documentation-audit
description: 'Audit and reconcile the on4net IDPN documentation tree: architecture, micro-frontend, design system, domain model, auth flows, API, security, integration guide, testing and roadmap. Use when checking documentation completeness, contradictions, stale references, broken links, or spec-vs-code drift. Never assume the docs are complete.'
argument-hint: 'Documentation area or feature to audit...'
---

# on4net IDPN Documentation Audit

Audit and reconcile the on4net IDPN docs against the implementation and GitHub Project #2.

## Documentation Tree
- `docs/README.md` — goals, scope, decisions, open questions, glossary
- `docs/architecture.md` — components, SSO, deployment, stack
- `docs/micro-frontend.md` — MFE contracts, versioning, isolation
- `docs/design-system.md` — shadcn/ui, tokens, RTL, MFE isolation
- `docs/domain-model.md` — entities, RBAC, claims, retention
- `docs/auth-flows.md` — OIDC, tokens, sessions, logout, social, MFA
- `docs/api.md` — OIDC and Admin API contract
- `docs/security.md` — threat model, controls, checklist
- `docs/integration-guide.md` — host/app integration
- `docs/testing.md` — unit/integration/contract/E2E strategy
- `docs/roadmap.md` — phases, acceptance, risks

## Core Rule
- Never assume the docs are complete or current. Cross-check against code, schema, OpenAPI and Project #2.

## What to Detect
- **Missing requirements** — behavior implemented or requested but absent from docs.
- **Contradictions** — statements that conflict between docs (e.g. stack, scopes, RTL, design system).
- **Stale references** — old design system names, old repo paths, removed endpoints, obsolete tasks.
- **Broken links** — relative links, anchors or documented paths that do not exist.
- **Spec-vs-code drift** — docs claim a feature exists but code/config does not, or vice versa.
- **API drift** — `docs/api.md` vs controllers/OpenAPI vs consumers.
- **Schema drift** — `docs/domain-model.md` vs migrations/ORM models.
- **Security drift** — `docs/security.md` vs actual cookies, scopes, rate limits, providers.
- **Test drift** — `docs/testing.md` vs actual suites and CI gates.
- **Project drift** — `docs/roadmap.md` vs Project #2 epics/tasks/status.

## Procedure
1. Inventory the docs and their last-updated state.
2. Cross-check domain model vs migrations/models; API vs controllers/OpenAPI; security vs config; UI vs design-system; roadmap vs Project #2.
3. Search for stale terms (old design systems, old repo names, `TODO`, `TBD`, placeholder URLs).
4. Validate relative links and code fences with a small script.
5. Report gaps with exact file/line references and severity.
6. Flag contradictions for a user decision; never resolve silently.

## Output Format
- Docs audited and scope
- Findings by category (missing / contradiction / stale / broken link / drift)
- Each finding: what exists where, what is missing/conflicting, severity
- Recommended reconciliation
- Contradictions requiring a decision