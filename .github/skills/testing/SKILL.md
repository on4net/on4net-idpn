---
name: testing
description: 'Determine the appropriate tests for the on4net IDPN API and web/MFE, run existing tests, identify missing coverage, and verify results. Use when asked to run tests, check test status, add tests, or verify a change does not break tests. Never claim tests passed unless they were actually executed.'
argument-hint: 'Test target: api, web, MFE, package, or specific feature...'
---

# on4net IDPN Testing

Determine the right tests for the affected area, run them, and report honestly what passed and what did not.

## When to Use
- A change affects `api/`, `web/`, or shared UI packages.
- The user asks to run tests, add tests, check coverage, or "make sure tests pass".

## Golden Rule
- NEVER claim tests passed unless you actually executed them and saw the pass result.
- If tests could not be run (missing env, missing deps, time), say so explicitly and mark the verification as unverified.

## Workspace Layout
- `api/` — NestJS + Fastify + TypeScript + PostgreSQL/Redis.
- `web/` — React 19 + Vite + shadcn/ui + Tailwind v4; Hosted Auth UI + embedded MFE (`account`, `user-management`).
- `packages/*` — shared UI/contracts (when present).
- `docs/testing.md` — source of truth for tiers, tools, coverage and CI gates.

## Commands (from repo root)
- Install: `pnpm install`
- Lint: `pnpm lint` · Type-check: `pnpm typecheck` · Build: `pnpm build`
- Unit: `pnpm test` or `pnpm vitest run`
- Integration: `pnpm test:integration` (Testcontainers: PostgreSQL/Redis)
- E2E: `pnpm test:e2e` (Playwright)
- Per package: `pnpm --filter <pkg> test` or run from the package directory.

## Procedure
1. Identify which area(s) the change touches (`api`, `web`, MFE, shared package).
2. Run the existing test suite for that area (prefer the smallest command that covers the change).
3. Record results accurately (counts, pass/fail).
4. Identify missing coverage: happy path, failure cases, security cases, RTL/A11y, Cross-Client, OIDC negative cases.
5. If tests fail, diagnose the cause — do not silently "fix" tests to green; verify the code is correct first.
6. Report what was run, what passed, what failed, and what coverage is missing.

## Output Format
- Areas/packages tested
- Commands run
- Results (PASS/FAIL/UNVERIFIED) with actual output summary
- Missing coverage / recommended new tests
- Any tests that could not be executed and why
