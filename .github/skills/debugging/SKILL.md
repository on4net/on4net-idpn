---
name: debugging
description: 'Find the root cause of a bug in on4net IDPN before changing code. Use when a feature is broken, an API fails, a service crashes, a web/MFE misbehaves, or behavior is unexpected. Inspect logs, call paths, dependencies, state, and API interactions. Do not apply superficial fixes.'
argument-hint: 'Bug or failing behavior to diagnose...'
---

# on4net IDPN Debugging

Find the root cause of a bug before changing any code. Do not apply superficial fixes.

## When to Use
- A feature, API, screen, or flow is broken or behaves unexpectedly.
- The user reports a bug and wants it fixed properly.

## Core Rules
- DO NOT guess or apply a patch that merely masks the symptom.
- Understand the failing path end-to-end before editing.
- Verify the root cause with evidence (logs, call stack, reproduction) before fixing.

## Procedure
1. **Reproduce** — establish a reliable reproduction of the bug. If you cannot reproduce, say so.
2. **Read the code path** — trace the request/event from entry (NestJS controller, BFF route, or React component) to the failure point. Use `rg`, LSP or the `usages` tool to locate the files/symbols involved instead of hunting by hand.
3. **Inspect logs and state** — check API logs (`docker compose logs`), error responses, and stored state (Postgres, Redis).
4. **Trace API interactions** — for bugs spanning API/web/MFE, verify the actual request/response between web/MFE and BFF/IdP. Confirm endpoints, payloads, and auth headers match the contract.
5. **Check dependencies and data** — verify DB state, schema expectations (`api/prisma/migrations/`), and library behavior relevant to the bug.
6. **Identify the root cause** — state the precise cause with evidence (file, function, condition).
7. **Propose the minimal fix** — only after the root cause is confirmed.
8. **Only then change code** — and re-run the reproduction plus relevant tests.

## Common IDPN Failure Points
- OIDC contract mismatch (issuer, audience, PKCE, redirect URI, state/nonce).
- Session/cookie problems (SameSite, domain, expiry, Redis).
- RBAC/Delegated Admin scope mismatch (`client_id`, `idp.client-admin`).
- MFE style/Portal leakage or Host version mismatch.
- Missing/incorrect validation causing bad data to reach handlers.
- Environment/config differences (env vars, DB connection, API base URL, provider credentials).
- Backwards-incompatible API change with an older consumer.
- Per-client social credential or callback mismatch.

## Output Format
- Repro steps (or why not reproducible)
- Root cause (with evidence)
- Files/functions involved
- Proposed minimal fix
- Verification steps after fix
