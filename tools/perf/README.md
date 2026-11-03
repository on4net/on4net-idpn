# Load / performance suite

Reproducible benchmark for the IDPN critical paths (issue #47). The k6 profile lives in
[`k6/load.js`](./k6/load.js); [`run-load.mjs`](./run-load.mjs) starts nothing implicitly but
checks the API health endpoint, picks a local `k6` or the pinned `grafana/k6` container, and
stores the summary under the git-ignored `artifacts/perf/`.

## What is measured

| Scenario | Endpoint | Smoke rate | Full rate | p95 target | p99 target |
|---|---|---|---|---|---|
| discovery | `/.well-known/openid-configuration` | 100/s | 200/s | 100ms | 250ms |
| jwks | `/.well-known/jwks.json` | 150/s | 300/s | 50ms | 150ms |
| authorize | `GET /oauth2/authorize` (existing session, PKCE, second client = SSO) | 30/s | 60/s | 150ms | 400ms |
| token_exchange | `authorization_code` grant + PKCE | 5/s | 10/s | 300ms | 750ms |
| token_refresh | `refresh_token` grant (rotation, one family per VU) | 5/s | 10/s | 300ms | 750ms |
| login | `POST /api/v1/login` (Argon2id) | 1/s | 2/s | 800ms | 1600ms |
| userinfo | `GET /oauth2/userinfo` | 100/s | 200/s | 150ms | 400ms |
| admin_users | `GET /api/v1/users?limit=25` | 30/s | 50/s | 300ms | 750ms |
| admin_audit | `GET /api/v1/audit-events?limit=25` | 30/s | 50/s | 300ms | 750ms |
| bundle | `GET /api/v1/clients/perf-app/translations/bundle` | 100/s | 200/s | 100ms | 250ms |
| mfe_remote | static `remoteEntry.js` (`MFE_BUNDLE_URL`) | 100/s | 200/s | 100ms | 250ms |

Global thresholds: `checks > 99%`, `http_req_failed < 1%`, `dropped_iterations == 0`, and a
per-scenario achieved-RPS floor (80% of the configured rate, discounted for the 5s warmup).
`smoke` is the CI gate; `full` is a capacity/soak run and is expected to expose saturation.

Warmup: a 5s `warmup` scenario hits the public endpoints before measurement. Setup (one login,
one code exchange, one access token, one shared session cookie) runs in k6 `setup()` and is
tagged `auth_setup`, so Argon2 cold starts do not pollute the measured percentiles. The refresh
scenario creates one refresh-token family per VU on its first iteration and rotates it.

`RATE_SCALE=N` multiplies every rate (capacity runs), `ONLY=a,b` selects scenarios and their
thresholds only, `DURATION=seconds` overrides the profile duration.

## Setup

```powershell
# 1. Local data stores (compose file in the repository root)
docker compose up -d postgres redis

# 2. Migrate and create the benchmark fixtures (local-only, idempotent, no real secret)
$env:DATABASE_URL = 'postgresql://idpn:idpn@127.0.0.1:55440/idpn'
pnpm --filter @idpn/api run db:deploy
pnpm perf:seed

# 3. Start the API on a dedicated port. ADMIN_CLIENT_ID points the admin audience at the
#    fixture client; the concurrency limit is disabled to avoid revoking benchmark sessions.
$env:PORT = '3100'
$env:HOST = '127.0.0.1'
$env:APP_URL = 'http://127.0.0.1:3100'
$env:HOSTED_UI_URL = 'http://127.0.0.1:3100'
$env:ADMIN_CLIENT_ID = 'perf-admin'
$env:REDIS_URL = 'redis://127.0.0.1:56380'
$env:SESSION_SECRET = 'local-benchmark-session-secret-32-chars'
$env:SESSION_MAX_CONCURRENT = '0'
$env:KEY_ROTATION_INTERVAL_DAYS = '0'
pnpm --filter @idpn/api start
```

Fixture values (all overridable by `PERF_*` environment variables, all local-only):

| Value | Default |
|---|---|
| admin client | `perf-admin` / `perf-admin-client-secret` |
| app client | `perf-app` |
| user | `perf@example.com` / `perf-user-password-123` (superadmin + client-wide memberships) |
| directory users | 250 password-less users so the paginated Admin API list is representative |
| redirect URIs | `http://127.0.0.1:3999/callback`, `http://127.0.0.1:3998/callback` |

## Run

```powershell
pnpm perf:load:smoke    # CI gate, ~20s of measured traffic + setup
pnpm perf:load:full     # DURATION=300, release soak
node tools/perf/run-load.mjs --profile smoke --only jwks --rate-scale 10 --duration 20
```

Static MFE remote (optional `mfe_remote` scenario):

```powershell
pnpm --filter @idpn/web run build:mfe
pnpm --filter @idpn/web exec vite preview --config vite.mfe.config.ts   # port 5174
$env:MFE_BUNDLE_URL = 'http://127.0.0.1:5174/remoteEntry.js'
node tools/perf/run-load.mjs --profile smoke --only mfe_remote --rate-scale 10 --duration 15
```

`vite.mfe.config.ts` adds `host.docker.internal` to `preview.allowedHosts` so the k6 container
can reach the preview server on Docker Desktop. Production serves the remote from a CDN and
does not use this check.

If `k6` is not on PATH, the pinned `grafana/k6:0.54.0` container is used. On Linux the
container shares the host network; on Docker Desktop a loopback `BASE_URL` is translated to
`host.docker.internal`.

Results: `artifacts/perf/<profile>-<timestamp>.json` (k6 summary) plus the per-endpoint table
printed by the runner. Recorded baselines live in
[`docs/performance-baseline.md`](../../docs/performance-baseline.md).

## Notes

- Thresholds are SLOs: do not raise one to make a run green. Investigate the cause or file a
  follow-up.
- Never point the fixtures at a production database. `perf:seed` writes users, clients and a
  superadmin assignment.
- Credentials in this file are local benchmark fixtures, equivalent to the E2E seed values; they
  are not production secrets and must not be reused outside a disposable environment.
