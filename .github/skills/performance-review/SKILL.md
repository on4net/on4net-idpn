---
name: performance-review
description: 'Review application performance across on4net IDPN: unnecessary API calls, expensive operations, rendering, database queries, memory usage, caching, and unnecessary rebuilds/renders. Use when asked to find performance problems, slow screens, N+1 requests, or to optimize rendering or queries.'
argument-hint: 'Performance area to review: API calls, rendering, queries, memory, or caching...'
---

# on4net IDPN Performance Review

Review performance across the API and web/MFE and find actionable improvements.

## When to Use
- A screen, page, or API is slow.
- The user asks to audit or improve performance.
- You changed code and want to verify no performance regression.

## Check Categories

### API calls (all apps)
- Unnecessary or repeated API calls (same endpoint fetched multiple times).
- Missing pagination or fetching more data than needed.
- N+1 request patterns (loop-triggered calls).
- Payloads larger than needed (unused fields).

### API — `api/` (NestJS + Fastify/TypeScript)
- Expensive operations in request handlers.
- Database query performance: missing indexes, full scans, N+1 queries.
- Blocking calls in async handlers (avoid blocking the event loop).
- Missing caching for expensive or stable results (Redis is available).
- Session/token issuance, JWKS cache and external provider calls adding latency; verify they are batched/needed.

### Web — `web/` (React 19 + Vite + shadcn/ui + MFE)
- Unnecessary re-renders (state churn, missing memoization where valuable).
- Heavy components rendering too often or too much.
- Large bundle contributions from imports (tree-shaking, dynamic import where valuable).
- Missing TanStack Query caching/staleness tuning and client-side fetch duplication.
- MFE Remote load time and duplicate React/Tailwind assets.

### Shared packages — `packages/*`
- Expensive utility logic called in hot paths.
- Unnecessary recomputation; missing memoization.

## Procedure
1. Identify the scope (app, screen, endpoint, or query).
2. Inspect the code path for the categories above.
3. For suspected N+1 / slow queries, confirm with the actual data access code.
4. Report findings with severity, evidence, and a concrete fix suggestion.
5. Do not change code unless asked; otherwise propose then apply minimal changes.

## Output Format
- Scope reviewed
- Findings by severity (with file references)
- Evidence for each finding
- Recommended fixes (with expected impact)
