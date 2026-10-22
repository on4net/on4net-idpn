# Security Review Report — on4net IDPN (Phase 6)

> Scope: full repository audit of `api/`, `web/`, `packages/`, `tools/`, deployment and CI
> configuration, plus dependency, supply-chain, secret and dynamic (ZAP) checks.
> Reference standard: OWASP ASVS Level 2, OWASP Top 10, OAuth 2.1 / OIDC.
> Card: #46 — "Run security review, penetration test and OIDC conformance".
> Date: 2026-10-19. Reviewer: developer agent (security-review skill), evidence in `artifacts/security/`.

> **Release gate re-verification (#49):** this report was re-validated on branch `a-main`
> HEAD `a1a47da` on 2026-10-20 after the login-context, session, localization, MFE-hardening and
> operations cards landed. See §10 for the final status, fresh-audit result and new evidence.
> `docs/release-readiness.md` holds the release go/no-go.

## 1. Executive summary

| Severity | Found | Fixed | Accepted / owner decision | Open |
|---|---:|---:|---:|---:|
| Critical | 0 | 0 | 0 | 0 |
| High | 4 | 3 | 1 | 0 |
| Medium | 3 | 1 | 2 | 0 |
| Low | 3 | 2 | 1 | 0 |
| Info | 3 | 0 | 3 | 0 |

No Critical finding was identified. All High findings are either fixed with regression tests
(H1, H2, H3) or fixed for the context-scoped model with the remaining part explicitly accepted
by the owner-backed rule set (H4). The main OIDC flows pass the available conformance checks
(23/23) and the ZAP baseline reports 0 failures.

## 2. Method and tooling

| Step | Tool / command | Result |
|---|---|---|
| Code audit | `security-review` skill (data-flow reasoning over `api/src`, `web/src`, `packages`) | 12 findings (below) |
| Dependency audit | `pnpm audit:ci` (`pnpm audit --audit-level=high`) | No known vulnerabilities |
| Supply chain | `pnpm supply-chain` (`tools/check-supply-chain.mjs --licenses`) | Passed: 14 pinned packages, react 19.3.1 |
| Secret scan | pattern scan over `git ls-files` (private keys, cloud keys, provider tokens, JWTs, `secret=` assignments) | 504 files scanned; 23 hits, all fake test fixtures or skill reference docs; no real secret |
| Dynamic baseline | `ghcr.io/zaproxy/zaproxy:stable zap-baseline.py` + automation plan | 0 FAIL, 1 WARN (storable 404 responses) |
| OIDC conformance | `tools/oidc-conformance.mjs` (23 protocol checks) | 23/23 pass |
| Conformance Suite | `registry.gitlab.com/openid/conformance-suite` | Image pulls and container starts; full plan needs MongoDB sidecar + browser-driven certification (owner follow-up, §7) |

## 3. Findings

| ID | Severity | Category | Finding | Status |
|---|---|---|---|---|
| H1 | High | XSS / open redirect | Hosted UI fell back to the raw `return_to` query value after login | **Fixed** |
| H2 | High | Authentication | MFA/step-up policy enforced only at password login; `/authorize` issued codes from password-only or social sessions | **Fixed** |
| H3 | High | Access control (T31) | `login_context` not persisted on authorization codes / refresh tokens | **Fixed** |
| H4 | High | Access control (T28/CTX-003) | `/authorize` issued codes without checking membership | **Partially fixed / accepted** |
| M1 | Medium | CSRF | `/api/v1/login` accepts cross-site form posts (login CSRF) | Open — accepted, owner action |
| M2 | Medium | Key management | `SIGNING_KEY_REF` parsed but ignored; ES256 key always in a local file | Open — owner decision |
| M3 | Medium | Protocol conformance | `/oauth2/token` returned `invalid_request`/400 for failed client auth instead of `invalid_client`/401 | **Fixed** |
| L1 | Low | Authentication | `pending` accounts could obtain full sessions | **Fixed** |
| L2 | Low | Configuration | `PASSWORD_PEPPER`, Argon2 tuning and `TRUSTED_PROXY_CIDRS` accepted but never applied | Open — accepted, owner action |
| L3 | Low | Security headers | API responses lacked `X-Content-Type-Options` (ZAP alert 10021) | **Fixed** |
| I1 | Info | Product decision | Consent gate defaults to granted and is never overridden | Owner decision |
| I2 | Info | DoS | No per-IP limiter on `/api/v1/login` and `/oauth2/token` (lockout only) | Owner decision |
| I3 | Info | Supply chain | MFE remote entry has no SRI/signed manifest (Module Federation limitation) | Owner decision |

### H1 — Unvalidated `return_to` fallback (DOM XSS / open redirect)

- **Evidence (audit time):** `web/src/app/hosted-login.tsx:385` read
  `return_to`/`redirect_uri` from the query string and lines `495`, `513`, `538` executed
  `navigateTo(result.redirectTo ?? returnTo ?? '/')` after password, TOTP and passkey success.
- **Exploitability:** the API only echoes a `redirectTo` it has validated (`sanitizeReturnTo`
  allows rooted paths or the IdP origin), and omits it when the value is unsafe. The SPA then
  fell back to the raw query value: `return_to=javascript:...` executed on the IdP origin after
  the victim authenticated (same-origin access to the account/MFA/session APIs), and
  `return_to=//evil.example` was a post-login open redirect.
- **Fix:** `safeRedirectTarget()` (`web/src/app/hosted-login.tsx:367`) accepts only rooted
  single-slash paths or absolute URLs on the IdP origin; all three success paths navigate only
  to the server-provided `redirectTo`.
- **Regression tests:** `web/src/app/hosted-login.test.tsx` — "never navigates to the raw
  return_to query value" and "rejects protocol-relative and off-site redirect targets"
  (`javascript:`, `//host`, `/\host`, off-site absolute).
- **Residual:** CSP is not shipped by the repository (I1/§6 owner action); the fix removes the
  sink, so CSP is defense in depth.

### H2 — MFA / step-up bypass at token issuance

- **Evidence (audit time):** `api/src/login/routes.ts:142-144` derived the MFA policy from the
  caller-supplied `clientId`/`loginContext`; `api/src/mfa/prisma-repository.ts:331-333` returned
  `optional` when no client was supplied. `/oauth2/authorize` issued a code from
  `session.userId` only (`api/src/oidc/authorize-route.ts:211-227`), and the social callback
  created `acr=urn:on4net:acr:social` sessions without consulting policy.
- **Exploitability:** omitting `clientId` at `POST /api/v1/login` produced a password-only
  session that `/authorize` accepted for a client with `mfaPolicy=required_all` (or for a
  `stepUpRequired` context requested with a weaker context at login). A social session had the
  same effect. The admin `requireMfa` guard option was never used by any route.
- **Fix:** the policy is re-evaluated at code issuance, for every session source:
  `api/src/oidc/authorize-enforcement.ts` (`createAuthorizeAuthenticationRequirement`) resolves
  client/context `mfaPolicy` + `stepUpRequired` + `required_admins` membership;
  `api/src/oidc/authorize-route.ts:251-283` redirects to the Hosted UI login (or returns
  `login_required` for `prompt=none`) when the session has no multi-factor ACR/AMR
  (`sessionHasMultiFactor`, line 348) or when a step-up context needs authentication fresher
  than `STEP_UP_MAX_AGE_SECONDS` (300 s, line 53). `acr_values=urn:on4net:acr:mfa` is honoured.
  Wiring: `api/src/index.ts` passes the MFA repository and the real client/membership data.
- **Regression tests:** `api/test/authorize-route.test.ts` (5 cases: password-only redirect,
  MFA session accepted, `prompt=none` → `login_required`, stale step-up forced re-auth,
  `acr_values` enforcement) and `api/src/oidc/authorize-enforcement.test.ts` (policy matrix).
- **Residual:** the login endpoint still derives a challenge from body parameters for UX
  (it cannot issue a token on its own); all authorization decisions now happen at `/authorize`.

### H3 — `login_context` dropped by the production code store (T31)

- **Evidence (audit time):** `api/src/oidc/prisma-code-repository.ts:18-31,43-63` did not persist
  or restore `loginContext`; `api/prisma/schema.prisma` had no column. The token endpoint passed
  `undefined` to role resolution (`api/src/oidc/token-route.ts:172-177`), so a context-scoped
  login received every client role, and refresh tokens were not bound to the context.
- **Fix:** migration `api/prisma/migrations/0007_login_context_binding` adds nullable
  `login_context` to `authorization_codes` and `refresh_tokens`; the Prisma code/refresh
  repositories persist and restore it (`api/src/oidc/prisma-code-repository.ts`,
  `api/src/oidc/prisma-refresh-repository.ts`); rotation keeps the binding
  (`api/src/oidc/refresh-token.ts`); the token route resolves roles with the context and emits
  the `login_context` claim on both grants (`api/src/oidc/token-route.ts:174,263,280`).
- **Regression test:** `api/test/cross-client-rbac.integration.test.ts` — "binds the login
  context to the code, token claims and refresh rotation" (roles `['app-a:editor']`,
  permissions `['app-a:contact:write']`, membership context `customer-admin`, same after refresh).
- **Note:** the remaining #62 scope (default context selection, selection page, `context_*`
  error mapping, resource-server enforcement) is still tracked by #62 and is not weakened by
  this change.

### H4 — `/authorize` without membership (T28 / CTX-003)

- **Evidence (audit time):** `api/src/oidc/authorize-route.ts:142-227` read the session and
  issued a code without any membership lookup; suspension only revoked sessions whose
  `session.clientId` matched the app (`api/src/admin/members/prisma-member-repository.ts:436-447`).
- **Fix:** `createAuthorizeMembershipStatus` (`api/src/oidc/authorize-enforcement.ts`) reads the
  membership for the client and, when requested, the exact login context. The route
  (`api/src/oidc/authorize-route.ts:224-247`) returns `access_denied` for a `suspended`
  membership and for a requested `login_context` without an `active` membership
  (`docs/login-contexts.md` 4.1, CTX-003).
- **Regression tests:** `api/test/authorize-route.test.ts` (suspended → `access_denied`,
  context without membership → `access_denied`, active context membership → code issued) and
  `api/src/oidc/authorize-enforcement.test.ts` (scoping of the lookup).
- **Accepted residual (owner decision):** for clients that define **no login context**, a
  user without a `ClientMembership` can still obtain a client-wide token. Making membership
  mandatory for every client is a product decision: the seed and the documented first-party
  bootstrap flows create no memberships, and `docs/auth-flows.md:470` expects membership to be
  created by invitation or social sign-up. Recommended owner action: decide that every active
  client requires an active null-context membership (or `registration_policy=self_service`
  auto-creates it) and, if so, make the lookup unconditional.

### M1 — Login CSRF (open, accepted)

- **Evidence:** `api/src/http/form-body.ts:19-31` registers a global urlencoded parser;
  `api/src/login/routes.ts:88-120` accepts `POST /api/v1/login` from any origin and sets the
  session cookie. `SameSite=Lax` does not stop the `Set-Cookie` of a top-level form post.
- **Impact:** an attacker can log a victim into the attacker's account and capture data the
  victim enters afterwards (classic login CSRF), or combine with a redirect to leak state.
- **Why not fixed here:** a strict same-origin check (`isSameOriginRequest` from
  `api/src/account/routes.ts:147`) changes the contract for non-browser callers and for the
  existing test harness; it needs a product decision on supported clients. Recommended fix:
  apply `isSameOriginRequest(request, options.appUrl)` plus `Sec-Fetch-Site` for browser
  requests, keep a documented allowance for server-to-server callers, and add negative tests.
- **Status:** accepted for this card, owner action.

### M2 — Signing key store ignores `SIGNING_KEY_REF` (fail-closed part fixed in card #70)

- **Evidence:** `api/src/index.ts` always constructs
  `new SigningKeyManager(new FileSigningKeyRepository('.idpn-keys.json'))`;
  `SIGNING_KEY_REF` is parsed in `packages/config/src/env.ts` but never read.
- **Impact:** a filesystem/container compromise yields the ES256 key and allows forging every
  access/ID/logout token for every client (docs/security.md T10). The file is 0600 and
  git-ignored, so this is a deployment-hardening gap rather than a code bug.
- **Required owner decision:** implement a KMS/Vault repository, or fail production startup
  when `SIGNING_KEY_REF` is set to an unsupported scheme. Rotation: plan re-signing known
  tokens / accepting overlap via JWKS.
- **Status (card #70):** the reference is now consumed
  (`api/src/oidc/signing-key-source.ts`): production startup requires `SIGNING_KEY_REF`, a
  `file://` reference is honoured, and every other scheme fails closed instead of falling back to
  a per-replica key file. **Still open:** the KMS/Vault adapter itself, which needs the backend
  choice.

### M3 — Token endpoint client-auth error (fixed)

- **Evidence (audit time):** `api/src/oidc/token-route.ts:108-118` returned
  `invalid_request` (HTTP 400/401) for every client-authentication failure, including unknown
  clients and wrong secrets.
- **Conformance impact:** RFC 6749 §5.2 requires `invalid_client` for a failed client
  authentication; OIDC conformance suites assert it.
- **Fix:** uniform `invalid_client` + HTTP 401 and `WWW-Authenticate: Basic` for Basic callers
  (`api/src/oidc/token-route.ts:108-115`); identical response for unknown client/wrong secret
  avoids enumeration. Test updated and strengthened in `api/test/token-route.test.ts`.

### L1 — Pending accounts could obtain sessions (fixed)

- **Evidence:** `api/src/auth/authenticate.ts:56-61` intentionally lets a `pending` user prove
  the password; `api/src/login/routes.ts` then created a session without re-checking status.
- **Fix:** `api/src/login/routes.ts` rejects any non-`active` account with the generic
  `invalid_credentials` response and audits `account_not_active`. Test:
  `api/test/login-route.test.ts` — "refuses to create a session for a pending account".

### L2 — Declared hardening configuration not applied (open, accepted)
- `PASSWORD_PEPPER`, `ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM` and
  `TRUSTED_PROXY_CIDRS` are validated but never passed to the hashers / Fastify. Operators who
  configure them silently get defaults, and per-IP limits/audit IPs are wrong behind a proxy.
  Owner/backlog action: thread the Argon2 parameters through `hashPassword`/`verifyPassword`
  call sites and set `Fastify({ trustProxy: ... })`.

### L3 — Missing `X-Content-Type-Options` (fixed)

- **Evidence:** ZAP automation alert `10021 X-Content-Type-Options Header Missing` on the
  discovery/JWKS/health responses.
- **Fix:** a global `onSend` hook in `api/src/server.ts` sets `X-Content-Type-Options: nosniff`
  and `Referrer-Policy: no-referrer` on API responses; asserted in `api/test/health.test.ts`.

## 4. `docs/security.md` §13 checklist mapping

Legend: ✅ verified in code/tests · ⚠️ partial (see finding) · ❌ not implemented in repository
(deployment/owner action).

| # | Checklist item | Status | Evidence |
|---|---|---|---|
| 1 | PKCE mandatory for every client | ✅ | `authorize-request.ts:102-112`; conformance check "missing PKCE is invalid_request" |
| 2 | Redirect URI exact match only | ✅ | `authorize-request.ts:183-189`; conformance checks (suffix, wildcard) |
| 3 | `state` and `nonce` verified | ✅ | required at `/authorize`; nonce bound into the ID token (`token-claims.ts`) |
| 4 | Code single-use, short-lived | ✅ | 256-bit, SHA-256 at rest, 60 s TTL, atomic consume (`authorization-code.ts`) |
| 5 | Refresh rotation + reuse detection | ✅ | `refresh-token.ts`; family revocation; integration tests |
| 6 | Access token ES256 with `kid` | ✅ | `keys.ts`; discovery/JWKS checks |
| 7 | JWKS rotatable with correct cache | ✅ | `key-rotation-scheduler.ts`; JWKS response |
| 8 | Passwords with Argon2id | ✅ | `auth/password.ts`; 64 MiB/t=3/p=1 |
| 9 | Rate limit and account lockout | ⚠️ | Lockout + account endpoint limiters; no per-IP limiter on `/login`/`/token` (I2) |
| 10 | No account enumeration | ✅ | generic `invalid_credentials`, decoy hash (`login/routes.ts`) |
| 11 | Cookies `HttpOnly; Secure; SameSite` | ✅ | `session/cookie.ts`; login test asserts flags |
| 12 | CSRF/Origin for cookie endpoints | ⚠️ | Account/admin routes enforce same-origin; `/api/v1/login` does not (M1) |
| 13 | MFA mandatory for admins | ✅ | enforced at `/authorize` for `required_admins` (H2 fix) |
| 14 | Step-up for sensitive operations | ⚠️ | Step-up contexts enforced at `/authorize` (5-min window); admin `requireMfa` unused |
| 15 | Sensitive events audited | ✅ | `audit/`, login/MFA/admin events; append-only trigger (0003) |
| 16 | Log redaction | ✅ | `audit/sanitize.ts`, `maskEmail`, key allowlist |
| 17 | Secrets in KMS/Vault | ❌ | Signing key is a local file; `SIGNING_KEY_REF` unused (M2) |
| 18 | CSP and HSTS enabled | ❌ | No web-server/CSP configuration in the repository (owner/deploy) |
| 19 | Dependencies and images scanned | ✅/⚠️ | `pnpm audit:ci` clean, supply-chain check; container scan not wired |
| 20 | Backup and restore tested | ❌ | Deployment concern, no runbook in repository |
| 21 | Incident runbook and contacts | ❌ | Not in repository (owner action) |
| 22 | Per-client social credentials, encrypted | ✅ | AES-256-GCM `secret-box.ts`, per-client rows |
| 23 | Social linking only with verified email | ✅ | `social/account-linking.ts`, provider checks |
| 24 | Social callback bound to `clientId` + provider | ✅ | single-use transactions, callback binding tests |
| 25 | Public config returns no secrets | ✅ | `public-config/build.ts` strict projection + contract |
| 26 | MFE loaded only from trusted versioned origin | ✅ | `MFE_PUBLIC_URL`/`MFE_VERSION`; operator-controlled |
| 27 | MFE CSS isolation | ✅ | Shadow DOM tests (`web/src/mfe`) |
| 28 | Radix portals inside the MFE root | ✅ | MFE tests |
| 29 | shadcn/ui + Tailwind pinned and in SBOM | ✅ | supply-chain check, SBOM script |
| 30 | Persian RTL + axe on shadcn components | ✅ | web test suite (axe/RTL) |
| 31 | MFE events carry no tokens | ✅ | host/web-component tests |
| 32 | Delegated admin negative tests | ✅ | `cross-client-rbac.integration.test.ts` |
| 33 | Suspended membership revokes app tokens | ✅ | member repository revocation + `/authorize` denial |
| 34 | Context issues only `allowed_roles`, no `idp:*` | ✅ | `effective-access.ts`; now persisted end-to-end (H3) |
| 35 | Resource server requires `login_context` on sensitive paths | ⚠️ | `userinfo` honours the claim; external resource servers are out of repo |
| 36 | Foreign/invalid `login_context` rejected | ✅ | `authorize-request.ts:128-131`; membership check |
| 37 | Translation text escaped | ✅ | localization tests |
| 38 | Locale from allowlist | ✅ | public config/localization tests |
| 39 | Context/translation changes audited + step-up | ⚠️ | audited; step-up for context changes is #62 scope |
| 40 | Social provider / sensitive role changes audited + step-up | ⚠️ | audited; `requireMfa` not wired |

## 5. ASVS Level 2 mapping (summary)

| ASVS chapter | Checklist items | Result |
|---|---|---|
| V2 Authentication | 1, 3, 8, 9, 10, 13, 14 | Pass except per-IP limiting (I2) and admin step-up (item 14) |
| V3 Session management | 11, 12, 33 | Pass except login CSRF (M1) |
| V4 Access control | 32, 34, 35, 36 | Pass (H4 residual for context-less clients accepted) |
| V5 Validation/encoding | 2, 37, 38 | Pass |
| V6 Cryptography | 4, 5, 6, 7, 8, 17 | Pass except KMS storage (M2) |
| V7 Error handling/logging | 10, 15, 16 | Pass; token error code fixed (M3) |
| V9 Communication | 18 | CSP/HSTS not in repo (deployment) |
| V10 Malicious code | 26–31 | Pass |
| V13 API | 19, 25 | Pass |
| V14 Configuration | 17, 20, 21 | Partial — deployment/owner actions |

## 6. Dynamic checks

### 6.1 ZAP baseline

- Command: `docker run --rm -v artifacts/security:/zap/wrk ghcr.io/zaproxy/zaproxy:stable
  zap-baseline.py -t http://host.docker.internal:3100 -r zap-baseline.html -J zap-baseline.json
  -m 5 -I`
- Result: `FAIL-NEW: 0`, `WARN-NEW: 1` (Storable and Cacheable Content on 404 responses for
  `/` and `/robots.txt`), `PASS: 66`.
- Interpretation: the API has no HTML surface and no authenticated crawl; passive rules that
  matter for a JSON API (CSP, cookies, headers, server leaks) passed. The 404-cache WARN is
  expected for an API root; the deployment should serve the Hosted UI at `/` and set explicit
  `Cache-Control` on 404s.
- Additional targeted requests (discovery, JWKS, public config, `/authorize` with valid and
  invalid redirect URIs, `/userinfo`, `/token`) were run with the ZAP automation framework
  (`docker run --rm -v artifacts/security:/zap/wrk ghcr.io/zaproxy/zaproxy:stable zap.sh -cmd
  -autorun /zap/wrk/zap-plan.yaml`). First run: one Low alert
  (`X-Content-Type-Options Header Missing`, 10021), fixed under L3. **Re-run on the final code:
  0 alerts** (`zap-automation.json`). The automation framework does not accept a request body
  for the `requestor` job (`Unrecognised parameter ... body`), so the `POST /oauth2/token`
  probe was executed without a body; grant-level checks are covered by §6.2.
- Final baseline artifacts: `zap-baseline-final.{html,json,md}` (0 FAIL, 1 WARN, 66 PASS).

### 6.2 OIDC conformance-style checks

- Command: `node tools/oidc-conformance.mjs --base http://127.0.0.1:3100 --client probe-client
  --redirect https://probe.example.com/cb --token-client conformance-spa`
  (`conformance-spa` is a local `type=spa` client without a secret; create an equivalent public
  client through the Admin API in another environment — `--token-client` must be spa/mobile).
- Result: **23/23 pass** (saved to `artifacts/security/oidc-conformance.txt`):
  discovery metadata (issuer, ES256 only, S256 only, no implicit/password), JWKS shape and no
  private material, mandatory PKCE/S256, `state`, `nonce`, `response_type`, exact redirect URI
  (suffix and wildcard rejected, never redirected), unknown client, token `invalid_client` /
  `unsupported_grant_type` / `invalid_grant`, `userinfo` bearer requirement.
- The first run exposed M3 (`invalid_request` for client auth failures); it was fixed and the
  suite now passes.

### 6.3 OpenID Conformance Suite (owner follow-up)

Image `registry.gitlab.com/openid/conformance-suite:latest` pulls successfully and the container
starts; a full certification run is not feasible in this environment because the suite needs a
MongoDB sidecar and browser-driven plan configuration, and the repository does not yet have a
certification client. Procedure to run it:

```yaml
# docker-compose.conformance.yaml
services:
  mongodb:
    image: mongo:7
    networks: [conformance]
  conformance:
    image: registry.gitlab.com/openid/conformance-suite:latest
    ports: ['18443:8443']
    environment:
      SERVER_NAME: localhost
      MONGODB_HOST: mongodb
    depends_on: [mongodb]
    networks: [conformance]
networks:
  conformance: {}
```

1. `docker compose -f docker-compose.conformance.yaml up -d`
2. Open `https://localhost:18443`, create a plan (e.g. `oidcc-basic-certification-test-plan`,
   variant `client_secret_post` or `client_secret_basic`).
3. Register the printed redirect URI (e.g. `https://localhost:18443/test/a/idpn/callback`) as a
   client in IDPN (`type=web`, PKCE required, scopes `openid profile email offline_access`).
4. Export the plan's client JSON into the suite and run it; export the result archive as
   evidence.
5. The suite must reach the API: run the API on `http://127.0.0.1:3100` and use
   `http://host.docker.internal:3100` as the issuer from inside the container, or publish the
   API on the compose network.

## 7. Owner actions / decisions

1. **H4 residual:** make membership mandatory for every active client (or auto-create it for
   `self_service`), and seed memberships for the first-party clients.
2. **M1:** decide the supported login callers, then apply a same-origin/`Sec-Fetch-Site` check
   to `POST /api/v1/login`.
3. **M2:** implement the KMS/Vault signing-key store (or hard-fail production startup when
   `SIGNING_KEY_REF` is unsupported) and plan rotation.
4. **CSP/HSTS/clickjacking:** add `Content-Security-Policy: default-src 'self';
   frame-ancestors 'none'` and HSTS at the edge for the Hosted UI; the repo ships no server
   configuration.
5. **Step-up for admin mutations:** wire `requireMfa`/fresh-`auth_time` into role assignment,
   client secret rotation, signing-key rotation and social-provider writes.
6. **Consent:** confirm first-party clients never need a consent screen; otherwise implement
   `isConsentGranted`.
7. **Rate limiting:** add per-IP/token-endpoint limits and configure `trustProxy` from
   `TRUSTED_PROXY_CIDRS`.
8. **Pending accounts:** confirm `pending` must never authenticate (implemented) or define a
   restricted verification-only session.
9. **Operational:** backup/restore test, incident runbook, container image scanning in CI.

## 8. Verification runs (final state)

| Check | Command | Result |
|---|---|---|
| Dependency audit | `pnpm audit:ci` | "No known vulnerabilities found" (exit 0) |
| Supply chain | `pnpm supply-chain` | "Supply-chain check passed: 14 pinned packages, react 19.3.1" (exit 0) |
| API typecheck | `pnpm --filter @idpn/api run typecheck` | exit 0 |
| API tests | `TEST_DATABASE_URL=... TEST_REDIS_URL=... pnpm --filter @idpn/api exec vitest run` | **79 files, 798 tests passed** (255 s, exit 0) |
| Web typecheck | `pnpm --filter @idpn/web run typecheck` | exit 0 |
| Web tests + coverage | `pnpm --filter @idpn/web run test:coverage -- --maxWorkers=2` | **21 files, 319 tests passed**; statements 92.69 %, branches 86.62 %, functions 92.48 %, lines 93.48 % (all thresholds met) |
| Lint (changed files) | `pnpm exec eslint <files>` | exit 0 |
| Format (changed files) | `npx prettier --check <files>` | exit 0 after formatting |
| Secret scan | tracked-files pattern scan | 0 real secrets (23 fixtures/doc examples) |
| OIDC checks | `node tools/oidc-conformance.mjs ...` | 23/23 pass |
| ZAP baseline | see §6.1 | 0 FAIL, 1 WARN (404 caching) |
| ZAP automation | see §6.1 | 0 alerts on final code (1 Low fixed) |

> The web suite is run with `--maxWorkers=2` on this workstation: the default worker pool
> exhausts memory and workers time out before executing tests (environment limitation, not a
> test failure). CI does not need the flag.

## 9. Reproducible commands

```powershell
pnpm audit:ci
pnpm supply-chain
pnpm --filter @idpn/api run typecheck
$env:TEST_DATABASE_URL=(...); $env:TEST_REDIS_URL=(...); pnpm --filter @idpn/api exec vitest run
pnpm --filter @idpn/web run typecheck
pnpm --filter @idpn/web run test:coverage
node tools/oidc-conformance.mjs --base http://127.0.0.1:3100 --client probe-client --redirect https://probe.example.com/cb --token-client conformance-spa
docker run --rm -v "${PWD}\artifacts\security:/zap/wrk:rw" ghcr.io/zaproxy/zaproxy:stable zap-baseline.py -t http://host.docker.internal:3100 -r zap-baseline.html -J zap-baseline.json -m 5 -I
```

Evidence artifacts (`artifacts/` is git-ignored): `zap-baseline.{html,json,md}`,
`oidc-conformance.txt`, `zap-plan.yaml`.

## 10. Release-gate re-verification (#49, HEAD `a1a47da`, 2026-10-20)

A fresh audit (security-review skill) was run against the current HEAD, covering the code that
landed after #46: context-enforced `/authorize`/`/token`/role resolution (#62), context admin
API and delegated scoping (#64), context-aware sessions and step-up (#65), hosted login-context
selector (#63), per-client localization (#59, #66) and the MFE/JWKS/operations work (#47, #56,
#57, ops).

### 10.1 Findings status on HEAD

| ID | Severity | Status on HEAD | Evidence |
|---|---|---|---|
| H1 | High | **Fixed** | `sanitizeReturnTo` only accepts rooted paths or the IdP origin (`api/src/login/login-types.ts:50-73`); the UI never falls back to the raw query (`web/src/app/hosted-login.tsx:423-437, 776, 800`); regression tests in `web/src/app/hosted-login.test.tsx`. |
| H2 | High | **Fixed** | Policy re-evaluated at code issuance for password, social and SSO sessions, including `acr_values` (`api/src/oidc/authorize-route.ts:300-331`, `authorize-enforcement.ts:24-42`); `api/test/authorize-route.test.ts`. |
| H3 | High | **Fixed** | `login_context` persisted on codes and refresh tokens (`prisma-code-repository.ts:20-55`, `prisma-refresh-repository.ts:20-68`), taken only from the stored row (`token-route.ts:185-213, 306-311, 358-382`); cross-client RBAC integration test. |
| H4 | High | **Partially fixed — accepted (owner)** | Context-scoped and context-less-request paths fail closed (`authorize-route.ts:255-291`, `effective-access.ts:118-135`); clients without active contexts keep the legacy membership-free path. Owner action §7.1. |
| M1 | Medium | **Open — accepted** | `/api/v1/login` has no origin check (`api/src/login/routes.ts:90`); owner action §7.2. |
| M2 | Medium | **Open — accepted** | Signing store hard-coded to `FileSigningKeyRepository('.idpn-keys.json')` (`api/src/index.ts:133`); `SIGNING_KEY_REF` unused. Owner action §7.3. |
| M3 | Medium | **Fixed** | `invalid_client` + 401 + `WWW-Authenticate: Basic` (`token-route.ts:134-140`); `api/test/token-route.test.ts`. |
| L1 | Low | **Fixed** | Non-active accounts rejected after password verification (`login/routes.ts:144-150`). |
| L2 | Low | **Open — accepted** | `PASSWORD_PEPPER`, Argon2 tuning and `TRUSTED_PROXY_CIDRS` still unapplied. Owner action §7.7. |
| L3 | Low | **Fixed** | `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` on every response (`api/src/server.ts:161-166`); `api/test/health.test.ts`. |
| I1–I3 | Info | **Accepted** | Consent default, per-IP limits and MFE SRI remain owner decisions (§7.6, §7.7, §7.5). |

**Fresh-audit verdict: no new Critical, High or credible Medium defect on HEAD.** Server-side
authorization was verified on every new id-based admin route: the path `clientId` is compared to
the token `client_id` claim (`api/src/admin/authorize.ts:201-225`), and context routes re-check
`adminContextScope` (`api/src/admin/members/routes.ts:132-183`). No IDOR/BOLA bypass was found in
context member ids, session revocation or `return_to` handling. Two below-threshold design
observations are recorded for the owner: `isDefault` is not part of the step-up field set for a
context update (`api/src/admin/login-contexts/routes.ts:34, 291`), and a role shared between two
contexts makes context role edits global by design of the user-level assignment model
(`api/src/admin/members/prisma-member-repository.ts:303, 487, 667`).

### 10.2 `docs/security.md` §13 final mapping

**32 of 40 items are verified in code and tests.** The other eight are deployment/owner items,
not code defects: two are not implemented in the repository — KMS/Vault signing-key storage (17)
and CSP/HSTS at the edge (18) — and six are partial: per-IP rate limiting (9), login CSRF (12),
admin step-up (14), external resource-server `login_context` enforcement (35, out of
repository), step-up for context/translation changes (39) and for social/sensitive-role changes
(40). Items 20 (backup/restore tested) and 21 (incident runbook and contacts) moved from ❌ to ✅
with the operations work (`docs/monitoring.md` §6, `docs/runbooks/incidents.md`). Accepted risks
and owner actions are in `docs/release-readiness.md` §6–§7.

### 10.3 Dynamic checks on HEAD

| Check | Result |
|---|---|
| ZAP baseline (`zap-baseline.py`, local API on `127.0.0.1:3100`) | **0 FAIL**, 1 WARN (storable 404 for `/`, `/robots.txt`, `/sitemap.xml`), 66 PASS — `artifacts/security/zap-baseline-49.{html,json}` |
| ZAP automation plan (discovery, JWKS, public config, valid/invalid authorize redirect, userinfo, `/api/v1/me`, `/metrics`, token) | **0 alerts**, "Automation plan succeeded", exit 0 — `artifacts/security/zap-automation-49.json`, plan `zap-plan-49.yaml` |
| OIDC conformance-style checks | **23/23 pass** — `artifacts/oidc-conformance-49.txt` |
| Secret scan (tracked files) | no real secret; only test fixtures and skill reference docs |
| `pnpm audit:ci` | "No known vulnerabilities found" |
| `pnpm supply-chain` | passed (14 pinned packages, React 19.3.1) |
| `pnpm sbom` | CycloneDX 1.5, 820 components |

OpenID Conformance Suite full run remains an owner action (§6.3): it needs a MongoDB sidecar and
browser-driven plan configuration, which this environment does not provide.

### 10.4 Release gate changes that touch security-relevant fixtures

- `api/prisma/seed.ts`: `admin-panel` now declares `supported: ['fa-IR','en-US']` so the Hosted
  UI honours `ui_locales` as documented. No security control changed.
- `api/scripts/seed-e2e.ts`: seeds idempotent active memberships (client-wide and default
  login context) for the E2E user, matching the fail-closed `/authorize` rule. This closes a
  fixture gap that had made the BFF SSO/logout E2E flow return `access_denied`.

### 10.5 Final security verdict

**PASS — no open Critical or High.** The accepted Medium/Low/Info items are documented with
named owner actions; none blocks a staging release candidate.

