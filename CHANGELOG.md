# Changelog

All notable changes to on4net IDPN are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.0] — 2026-10-20

First release candidate of the on4net IDPN platform, covering phases 0–6 of
[`docs/roadmap.md`](docs/roadmap.md). The release gate evidence is in
[`docs/release-readiness.md`](docs/release-readiness.md).

### Added

- Workspace scaffold (`api/`, `web/`, `packages/*`, `examples/bff`), Docker Compose for
  PostgreSQL 16, Redis 7 and Mailhog, CI with lint, typecheck, contract, build, unit,
  integration, observability, supply-chain, MFE security, performance smoke, a11y, visual and
  E2E jobs.
- OIDC/OAuth 2.1 provider: discovery, JWKS, `/oauth2/authorize`, `/oauth2/token`,
  `/userinfo`, RP-initiated and back-channel logout, Authorization Code + PKCE (S256) only,
  ES256 signing keys with rotation and overlap, refresh-token rotation with reuse detection.
- Hosted Authentication UI (React 19 + Vite + shadcn/ui + Tailwind v4) with MFA (TOTP,
  passkeys, recovery codes), social sign-in, account and password flows, invite/verify/reset,
  Persian RTL and English LTR.
- Per-client social providers (Google OIDC, Facebook OAuth2) with encrypted credentials,
  verified-email account linking and client/provider-bound callbacks.
- Admin API and console: users, clients, secrets, roles and permissions, memberships,
  delegated client admins, sessions, audit viewer.
- Micro-frontends: `account` and `user-management` via Module Federation and a Web Component,
  versioned config/event contract, `@idpn/mfe-sdk`, CSS/Preflight isolation, Radix portals
  scoped inside the MFE root, BFF and SPA token modes.
- Login contexts: per-app login models with allowed roles, per-context MFA/step-up,
  context-aware sessions and switching, enforced at `/authorize`, `/token` and role resolution.
- Per-client localization: enabled locales, overrides and public bundle with cache versioning.
- Operations: `/healthz`, `/readyz`, protected `/metrics`, Prometheus alerts, Grafana
  dashboard, Loki configuration, backup/restore tooling with checksums, encryption, retention
  and a documented restore drill, incident and app-onboarding runbooks, shared staging compose.
- Security baseline: OWASP ASVS L2 review (`docs/security-review-report.md`), ZAP baseline and
  automation scans, local OIDC conformance checks, audit trail (append-only), secret and
  supply-chain checks, CycloneDX SBOM.

### Security

- MFA policy and step-up are re-evaluated at authorization-code issuance for every session
  source (password, social, SSO), including `prompt=none`.
- `login_context` is persisted on authorization codes, refresh tokens and sessions; tokens
  carry only the roles allowed by the context and never `idp:*` for client scopes.
- `/authorize` fails closed for clients with login contexts when no active membership exists
  for the requested scope.
- Hosted UI never falls back to the raw `return_to` value; only the server-validated
  `redirectTo` is navigated to.
- Token-endpoint client authentication failures return `invalid_client`/401 uniformly.

### Known limitations

- Login CSRF on `POST /api/v1/login` (`M1`), signing-key storage in a local file (`M2`),
  CSP/HSTS at the edge, per-IP rate limiting and admin step-up for every mutation
  (`L2`, `I2`, security report §7) are accepted for this candidate with owner actions.
- `/oauth2/token` misses the p95 < 300 ms SLO under the 20 req/s `full` load profile on a
  single API process (card #68, `docs/performance-baseline.md` §3).
- A full OpenID conformance-suite certification run still needs an owner-run environment with
  the suite plus a MongoDB sidecar (`docs/security-review-report.md` §6.3).
