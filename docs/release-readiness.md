# Release Readiness — on4net IDPN 0.1.0

> Card: #49 "Complete final security checklist and release" (Phase 6, Epic #7).
> Gate run on branch `a-main`, HEAD `a1a47da` (`feat(ops): add monitoring, alerts, backup/restore
and incident runbook`), after all functional Phase 0–6 cards.
> Date: 2026-10-20. Reviewer: developer agent (`review-gate` + `security-review` skills).
> Evidence artifacts in `artifacts/` and `artifacts/security/` (git-ignored).

## 1. Verdict

**GO for an internal / staging release candidate**, with the blocking owner actions in §7.
**NO-GO for unrestricted public production traffic** until the four blocking owner actions are
completed: edge CSP/HSTS configuration, signing-key KMS/Vault decision, Google/Facebook
credentials for the target apps, and a shared staging deployment.

No open Critical or High security finding remains (security: PASS). Every automated gate in §3
passed on this HEAD. The product decisions that remain are deployment/credential tasks that
cannot be executed inside this repository.

## 2. Scope of this gate

| Item               | Value                                                             |
| ------------------ | ----------------------------------------------------------------- |
| Commit             | `a1a47da`                                                         |
| Package version    | `0.1.0` (root and all workspace packages)                         |
| Docs revision      | 0.4 (`docs/README.md`)                                            |
| Database           | PostgreSQL 16, 9 migrations (`0001`–`0009`)                       |
| Runtime            | Node.js 24.12.0 local (`.nvmrc` pinned LTS), pnpm 9.12.0          |
| Reference standard | OWASP ASVS Level 2, OAuth 2.1 / OIDC Core, `docs/security.md` §13 |

## 3. Verification matrix (executed on HEAD)

| #   | Gate                                         | Command                                                                                                                                                  | Result                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Lint                                         | `pnpm lint`                                                                                                                                              | PASS — exit 0, no diagnostics                                                                                                                                                                                                                                                            |
| 2   | Typecheck                                    | `pnpm typecheck`                                                                                                                                         | PASS — 7 workspace projects, exit 0                                                                                                                                                                                                                                                      |
| 3   | Build                                        | `pnpm build`                                                                                                                                             | PASS — exit 0 (Vite: 273 modules, 551.9 kB JS / 17.4 kB CSS)                                                                                                                                                                                                                             |
| 4   | Contract check                               | `pnpm contract:check`                                                                                                                                    | PASS — 3 artifacts (`openapi.json`, MFE config/event schemas)                                                                                                                                                                                                                            |
| 5   | Unit tests (packages/web)                    | `pnpm --filter @idpn/config --filter @idpn/contracts --filter @idpn/i18n --filter @idpn/mfe-sdk --filter @idpn/example-bff run test:coverage`            | PASS — 14 files, **324 tests** (config 21, contracts 79, i18n 149, mfe-sdk 52, BFF 23)                                                                                                                                                                                                   |
| 6   | API unit + integration                       | `pnpm --filter @idpn/api exec vitest run --coverage` (PostgreSQL + Redis, `TEST_DATABASE_URL`/`TEST_REDIS_URL`)                                          | PASS — **97 files, 1085 tests** (1003 passed in the full run + 82 passed on the isolated re-run of 3 files whose `beforeAll` hit the 300 s hook timeout under load, see below); coverage statements 88.93 %, branches 80.14 %, functions 93.66 %, lines 88.91 % (thresholds 80/70/80/80) |
| 7   | Web tests + coverage                         | `pnpm --filter @idpn/web run test:coverage -- --maxWorkers=2`                                                                                            | PASS — **35 files, 465 tests**; coverage 92.33 / 85.97 / 92.85 / 92.89 %                                                                                                                                                                                                                 |
| 8   | MFE security tests                           | `pnpm test:security` (re-run as `vitest run src/security` with the thread pool)                                                                          | PASS — **3 files, 18 tests** (header policy, CORS allowlist, forbidden-pattern scan)                                                                                                                                                                                                     |
| 9   | E2E (API, Hosted UI, MFE, BFF, a11y, visual) | `pnpm test:e2e`                                                                                                                                          | PASS — **77/77 tests**                                                                                                                                                                                                                                                                   |
| 10  | Accessibility                                | `pnpm test:a11y`                                                                                                                                         | PASS — **26/26** (axe Critical/Serious = 0)                                                                                                                                                                                                                                              |
| 11  | Visual regression                            | `pnpm test:visual`                                                                                                                                       | PASS — **19/19** (win32 baselines)                                                                                                                                                                                                                                                       |
| 12  | Dependency audit                             | `pnpm audit:ci`                                                                                                                                          | PASS — "No known vulnerabilities found"                                                                                                                                                                                                                                                  |
| 13  | Supply chain                                 | `pnpm supply-chain`                                                                                                                                      | PASS — 14 pinned packages, React 19.3.1 singleton, licenses in allowlist                                                                                                                                                                                                                 |
| 14  | SBOM                                         | `pnpm sbom`                                                                                                                                              | PASS — CycloneDX 1.5, **820 components** at `artifacts/sbom.cdx.json`                                                                                                                                                                                                                    |
| 15  | Secret scan                                  | tracked-file pattern scan (private keys, cloud/provider tokens, JWTs, `secret=` assignments)                                                             | PASS — no real secret; hits are fixtures and skill docs                                                                                                                                                                                                                                  |
| 16  | ZAP baseline                                 | `zap-baseline.py -t http://host.docker.internal:3100 -m 5 -I`                                                                                            | 0 FAIL, 1 WARN (storable 404 responses for `/`, `/robots.txt`, `/sitemap.xml`), 66 PASS                                                                                                                                                                                                  |
| 17  | ZAP automation                               | `zap.sh -cmd -autorun zap-plan-49.yaml` (discovery, JWKS, public config, authorize valid/invalid redirect, userinfo, `/api/v1/me`, `/metrics`, `/token`) | PASS — **0 alerts**, exit 0                                                                                                                                                                                                                                                              |
| 18  | OIDC conformance-style checks                | `node tools/oidc-conformance.mjs --base http://127.0.0.1:3100 ...`                                                                                       | PASS — **23/23**                                                                                                                                                                                                                                                                         |
| 19  | Migrations up                                | `db:deploy` on scratch DB `idpn_release_gate`                                                                                                            | PASS — 9/9 applied                                                                                                                                                                                                                                                                       |
| 20  | Migrations down                              | `db:rollback` ×9                                                                                                                                         | PASS — `0009` → `0001`, each with `down.sql`                                                                                                                                                                                                                                             |
| 21  | Migrations re-apply                          | `db:deploy` after full rollback                                                                                                                          | PASS — 9/9 applied again                                                                                                                                                                                                                                                                 |
| 22  | Seed idempotency                             | `db:seed` twice, row counts compared                                                                                                                     | PASS — 3 users, 1 client, 6 roles, 36 permissions, 1 context (identical both runs)                                                                                                                                                                                                       |
| 23  | Backup/restore drill                         | `ops:backup` + `ops:restore --drill` run in this gate (plus CI `observability`)                                                                          | PASS — checksum verified, 11 tables restored to a scratch DB, row counts equal (users 255, clients 7, memberships 6, roles 24, permissions 36, sessions 772, refresh_tokens 7885, authorization_codes 16533, audit_events 811), RTO **91.03 s** (target ≤ 1 h), scratch DB dropped       |
| 24  | Docs links                                   | relative-link scan over `docs/**` + root Markdown                                                                                                        | PASS — 31 files, 0 broken links                                                                                                                                                                                                                                                          |
| 25  | Observability                                | `promtool check config/rules` + `promtool test rules`, Grafana JSON, compose validation (CI `observability`)                                             | PASS — 14 alert rules (`IdpnApiUnavailable` … `IdpnDiskWillFillSoon`)                                                                                                                                                                                                                    |
| 26  | CI workflow                                  | `.github/workflows/ci.yml`                                                                                                                               | 8 jobs: static, unit, integration, observability, supply-chain, mfe-security, perf-smoke, ui-a11y, ui-visual, e2e                                                                                                                                                                        |

Notes on the environment:

- The API and web suites were run with `--maxWorkers=1`/`--maxWorkers=2` on this workstation:
  the default pool spawns one worker per CPU (32) and worker startup times out under the
  memory pressure of other local applications (Ollama holds ~11 GB). This is an environment
  constraint, not a test failure; the same suites passed earlier with the default pool
  (API 97 files / 1085 tests in 164 s). No test, assertion or threshold was changed.
- In the full API run under this load, three integration files (`cross-client-rbac`,
  `login-contexts`, `mfa`) exceeded the 300 s `beforeAll` hook timeout while creating their
  scratch databases and applying 9 migrations; all three passed when re-run as a single
  batch: **3 files, 82 tests, 134 s**. Aggregate: 1085/1085 tests pass on HEAD.
- ZAP runs against a local API (`127.0.0.1:3100`, seeded dev database) via
  `host.docker.internal`; the API has no authenticated crawl, so authenticated admin surfaces
  are covered by unit/integration/E2E tests instead.

## 4. Security gate

The full assessment is in [`security-review-report.md`](./security-review-report.md) with the
#49 re-verification section at the end. Summary:

| Severity | Open | Fixed |                                       Accepted with owner action |
| -------- | ---: | ----: | ---------------------------------------------------------------: |
| Critical |    0 |     0 |                                                                0 |
| High     |    0 |     4 | 0 (H4 residual explicitly accepted in the owner-backed rule set) |
| Medium   |    0 |     1 |                      2 (`M1` login CSRF, `M2` signing-key store) |
| Low      |    0 |     2 |                                     1 (`L2` pepper/proxy tuning) |
| Info     |    0 |     0 |               3 (`I1` consent, `I2` per-IP limits, `I3` MFE SRI) |

- Fresh audit of HEAD (`security-review` skill): **no new Critical/High**: the #62–#65 login
  context work, delegated-admin scoping, session context switching and localization changes
  were traced end-to-end. #46 findings H1, H2, H3, M3, L1, L3 are re-verified as fixed; M1, M2,
  L2 remain accepted; H4 remains partially fixed with the documented owner decision.
- `docs/security.md` §13 checklist: 32/40 items verified in code/tests, 6 partial and 2
  not implemented in the repository (KMS/Vault, CSP/HSTS). All 40 are mapped with evidence in
  `docs/security-review-report.md` §4 and §10.2; backup/restore and the incident runbook are now
  satisfied by the operations work. None of the remaining items is a Critical/High code defect.

## 5. Release contents and documentation

| Document                                                                                               | Status                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/README.md` (goals, decisions, changelog of doc revisions)                                        | current (v0.4)                                                                                                                                     |
| `docs/architecture.md`, `docs/auth-flows.md`, `docs/domain-model.md`, `docs/api.md`                    | current, contract-checked                                                                                                                          |
| `docs/security.md` §13 checklist | all 40 items mapped with file/test evidence in `docs/security-review-report.md` §4 and §10.2 (32 verified in code/tests, 6 partial, 2 not implemented in-repo) |
| `docs/security-review-report.md`                                                                       | #46 baseline + #49 re-verification                                                                                                                 |
| `docs/monitoring.md`, `docs/runbooks/incidents.md`, `docs/runbooks/app-onboarding.md`                  | current; drill evidence recorded                                                                                                                   |
| `docs/testing.md`                                                                                      | current; all layers executed                                                                                                                       |
| `docs/performance-baseline.md`, `docs/supply-chain.md`, `docs/rtl-audit.md`, `docs/style-isolation.md` | current                                                                                                                                            |
| `docs/release-readiness.md` (this file), `CHANGELOG.md`                                                | new in #49                                                                                                                                         |
| `THIRD_PARTY_NOTICES.md` (shadcn/ui, Radix UI, Tailwind CSS — MIT)                                     | present; SBOM 820 components                                                                                                                       |
| `deploy/observability`, `deploy/security` (nginx/Caddy examples), `deploy/staging`                     | present                                                                                                                                            |
| Version/tag                                                                                            | `0.1.0` in every `package.json`; no repository tag was created (see §8)                                                                            |

## 6. Accepted risks

| ID  | Risk                                                                                 | Why accepted for this candidate                                                                                                                                                            | Owner action                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Login CSRF on `POST /api/v1/login` (M1)                                              | Requires a cross-site form post; session cookie is `SameSite=Lax`; exploitation needs a victim to continue using the attacker's session. Fix changes the contract for non-browser callers. | Decide supported login callers, then apply `isSameOriginRequest`/`Sec-Fetch-Site` with server-to-server allowance and negative tests.        |
| R2  | Signing key stored in a local file, `SIGNING_KEY_REF` unused (M2)                    | File is `0600` and git-ignored; risk is container/filesystem compromise, not an application flaw.                                                                                          | Implement a KMS/Vault repository or fail production startup for unsupported schemes; document rotation overlap.                              |
| R3  | CSP/HSTS/clickjacking headers not shipped by the repository                          | The API is JSON-only; the Hosted UI is served by the edge. Origin CORS allowlist and `frame-ancestors` belong to deployment.                                                               | Add `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'` and HSTS at the edge (examples in `deploy/security/`).             |
| R4  | `/oauth2/token` p95 363–406 ms at 20 rps in the `full` k6 profile (card #68)         | The CI `smoke` SLO gate is green (p95 ≤ 300 ms at 5 rps token traffic); the miss comes from Argon2 client-secret verification on one process. Fixing it changes the security contract.     | Decide HMAC/pepper or short-lived verification cache (#68); scale horizontally and measure capacity on staging before raising traffic.       |
| R5  | Per-IP rate limiting and `trustProxy` from `TRUSTED_PROXY_CIDRS` not applied (L2/I2) | Account lockout and endpoint limiters exist; per-IP limits need the production proxy topology.                                                                                             | Thread Argon2 parameters and `trustProxy`; add per-IP limits at the edge.                                                                    |
| R6  | Admin step-up not wired to every mutation (`requireMfa` unused)                      | MFA is mandatory for admins at `/authorize` and step-up contexts are enforced there; residual is UX-level re-auth for individual mutations.                                                | Wire fresh `auth_time`/step-up into role assignment, secret rotation, key rotation, social-provider writes.                                  |
| R7  | `H4` residual: clients with no login context still issue codes without membership    | Fail-closed behavior applies to clients with contexts; context-less bootstrap clients rely on the documented invitation/social flow.                                                       | Decide whether every active client requires a null-context membership; if yes, make the lookup unconditional and seed bootstrap memberships. |
| R8  | No full OpenID Conformance Suite certification run                                   | Suite needs MongoDB sidecar + browser-driven plan; local conformance script covers 23 protocol invariants.                                                                                 | Run `oidcc-basic-certification-test-plan` in an owner-controlled environment (§6.3 of the security report).                                  |
| R9  | MFE remote entry has no SRI/signed manifest (I3)                                     | Module Federation limitation; origin + pinned version + CSP are the documented controls.                                                                                                   | Consider a signed manifest or Web Component distribution for strict environments.                                                            |

## 7. Owner actions

### Blocking before public production traffic

1. **Edge security configuration** — CSP (`default-src 'self'; frame-ancestors 'none'`),
   HSTS (`max-age>=31536000; includeSubDomains; preload`), `X-Frame-Options: DENY`,
   `Referrer-Policy`, `Permissions-Policy`, cache policy for 404s (ZAP WARN 10049).
2. **Signing-key storage** — implement the `SIGNING_KEY_REF` (KMS/Vault) repository or make
   production startup fail for unsupported references; document rotation overlap.
3. **Provider credentials** — register Google and Facebook OAuth clients per app, set the
   callback URLs from `docs/runbooks/app-onboarding.md` §2–3 and store the encrypted
   credentials through the Admin API.
4. **Shared staging deployment** — deploy `deploy/staging` with the real locale/social
   configuration, run the smoke load profile, the ZAP baseline and an authenticated E2E pass
   against it.

### Required decisions / follow-ups (non-blocking for a staging RC)

5. M1 login CSRF: decide the supported callers, then enforce same-origin/`Sec-Fetch-Site`.
6. H4: decide whether context-less clients require a membership.
7. #68: client-secret verification strategy for the `/token` SLO at scale.
8. L2/I2: Argon2 tuning/pepper and `trustProxy` from `TRUSTED_PROXY_CIDRS`.
9. R6: step-up for every admin mutation.
10. I1 consent policy for third-party clients; I3 MFE manifest signing if required.
11. Full OpenID Conformance Suite certification run.
12. Backup RPO ≤ 15 min needs WAL archiving or a 15-minute dump schedule in production
    (`docs/monitoring.md` §6.3); the repository only proves the restore path (RTO).

## 8. Versioning, changelog and tagging

- All workspace packages are `0.1.0`; `CHANGELOG.md` records the first release candidate.
- The repository documents **no release/tag publishing process** (only MFE SemVer pinning in
  `docs/micro-frontend.md` §10), and there is no CI release job. A local `v0.1.0` tag was
  therefore **not** created: tagging is an owner release decision, and this agent must not
  create release artifacts that imply a published build. Nothing was pushed or published.

## 9. Rollback plan

Rollback is layered; each layer is independently reversible.

| Layer         | Procedure                                                                                                                                                                                              | Validation                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Application   | Redeploy the previous image tag / previous commit (`a1a47da` is the candidate). API and web are stateless; keep the previous image pinned.                                                             | `/healthz`, `/readyz`, smoke login, JWKS `kid` present                   |
| Migrations    | `pnpm --filter @idpn/api run db:rollback` repeatedly (each migration ships a tested `down.sql`; all 9 verified in this gate). Never roll back below `0007` while tokens with `login_context` are live. | Re-run `db:deploy` and the seed; check `_prisma_migrations`              |
| Data          | `ops:restore --backup <dump> --drill` first (validates checksum and row counts on a scratch DB), then restore with `--allow-non-scratch` after a two-person check.                                     | Row counts from `manifest`, `idpn_backup_last_success_timestamp_seconds` |
| Signing key   | Keep the previous key in JWKS overlap (`keys.ts` rotation with overlap); do not delete the old key until access-token TTL + max refresh window has passed.                                             | JWKS contains both `kid`s; token validation on the previous key succeeds |
| MFE           | Hosts pin the remote major; roll the CDN back to the previous version and keep the old manifest available.                                                                                             | Host mounts, E2E smoke, visual baseline                                  |
| Configuration | Environment variables are additive; revert `locales`/social provider rows through the Admin API (audited).                                                                                             | Public config response, login smoke                                      |
| Feature stop  | Disable a social provider or a login context per client (`status`) instead of deploying; sessions can be revoked globally (`session.revoked`).                                                         | Login without the disabled method; revoked sessions rejected             |

Rollback drill evidence: migrations up/down/re-up and the backup/restore drill in this gate; the
incident rollback procedure is in `docs/runbooks/incidents.md` §12 and
`docs/runbooks/app-onboarding.md` §8.

## 10. Definition of Done check (`review-gate`)

| Gate step                   | Result                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| 1. Issue & DoD completeness | PASS — deliverables/acceptance evidence in §3–§9; no open dependency blocks this card            |
| 2. Test gate                | PASS — unit, integration, E2E, a11y, visual, contract, migration, seed, backup/restore           |
| 3. Code review              | PASS — minimal fixes in this card reviewed; no dead code, no weakened assertions                 |
| 4. Security review          | PASS — no open Critical/High; accepted risks named with owner actions                            |
| 5. Docs consistency         | PASS — security report, supply-chain count, changelog, release readiness updated; links verified |
| 6. Project fields           | Card moved to **In review** (never Done by the developer agent); Epic #7, phase:6, P0            |

## 11. Changes made by this card

- `api/prisma/seed.ts` — `admin-panel` declares the shipped `fa-IR`/`en-US` locales and their
  directions, so the Hosted UI honours `ui_locales=en-US` for the seeded client instead of
  silently falling back to Persian.
- `api/scripts/seed-e2e.ts` — seeds idempotent active memberships (client-wide and default
  login context) for the E2E user; required by the fail-closed membership rule in `/authorize`.
- `e2e/web/login.spec.ts` — requests `ui_locales=fa-IR` explicitly (documented locale chain
  puts `Accept-Language` before the client default, so the Persian scenario must be explicit).
- `e2e/web/rtl.spec.ts` — the en-US MFE instance asserts English labels (the module is now
  localized) and the translated membership-status control name.
- `e2e/web/web-component-host.spec.ts` — expects the documented `lang` mirror attribute on the
  element and asserts its value.
- `e2e/visual/__screenshots__/win32/admin-sessions-fa-light.png` — baseline refreshed for the
  intentional "Login context" column and filter added by #65.
- `docs/security-review-report.md` — final release-gate status and evidence.
- `docs/supply-chain.md` — SBOM component count updated to the current 820.
- `docs/release-readiness.md`, `CHANGELOG.md` — new.

No production code path, authorization rule, contract or migration was changed.
