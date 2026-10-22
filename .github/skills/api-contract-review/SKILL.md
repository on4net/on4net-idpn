---
name: api-contract-review
description: 'Review API compatibility for on4net IDPN: NestJS + Fastify backends, OIDC/OAuth endpoints, Admin API, React 19/Vite web and MFE consumers, and OpenAPI/Zod contracts. Use when an API changes, when checking endpoints, request/response models, validation, auth, authorization, errors, pagination, or backwards compatibility, or when verifying client consumers match the backend.'
argument-hint: 'API contract to review (endpoint, change, or feature)...'
---

# on4net IDPN API Contract Review

Review API compatibility across the IdP, Admin API, BFF consumers and MFE.

## When to Use
- A backend API is added, changed, or removed.
- A web/MFE or BFF consumes an API.
- The user asks to check endpoint compatibility, request/response shapes, or backwards compatibility.

## Architecture Notes
- Backends: NestJS + Fastify in `api/` (TypeScript, Zod/class-validator).
- OIDC endpoints: `/oauth2/*` and `/.well-known/*` (form-encoded, standard OAuth errors).
- Admin API: `/api/v1/*` with `idp.admin` (Global) and `idp.client-admin` (Delegated) scopes.
- Consumers: `web/` (React 19 + Vite), embedded MFE, and app BFFs.
- Contracts: OpenAPI 3.1 in `docs/api.md` / generated schema, plus Zod schemas.
- Source of truth: `docs/api.md` and `docs/domain-model.md`.

## Check Categories
For each relevant endpoint, check:

- **Endpoint and method** — path + HTTP method match between backend and each consumer.
- **Request models** — fields, types, required/optional, and validation (zod schemas) match what clients send.
- **Response models** — fields, types, and shape match what clients parse.
- **Validation** — backend validation aligns with client-side expectations.
- **Authentication** — activation/API-key/token requirements match how clients attach credentials.
- **Authorization** — role/permission (RBAC) checks match the client context.
- **Errors** — error codes/shapes clients handle match backend responses.
- **Pagination** — page/limit/offset or cursor conventions match across apps.
- **Backwards compatibility** — will the change break existing web/service consumers that have not been updated?
- **Client consumers** — find every consumer of the endpoint (web/MFE, BFF, other services) and verify each.

## Procedure
1. Identify the endpoint(s) in scope.
2. Read the backend implementation (NestJS controller/service + Zod schema in `api/`) and the OpenAPI contract.
3. Find all consumers in `web/`, the embedded MFE, BFFs, and any service-to-service callers.
4. Compare request, response, auth, errors, and pagination between backend and each consumer.
5. Verify OIDC error shapes (`error`, `error_description`) and Admin API RFC 9457 problem details.
6. Flag mismatches with severity (Critical/High/Medium/Low).
7. Note backwards-compatibility impact for each affected consumer.

## Output Format
- Endpoints reviewed
- Per-endpoint verdict: COMPATIBLE / MISMATCH / MISSING CONSUMER UPDATE
- Findings by severity (with file references)
- Backwards-compatibility notes
- Recommended changes
