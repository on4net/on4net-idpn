# Sample BFF (`examples/bff`)

A small platform application that signs users in with the on4net IDPN using the **Backend for
Frontend** pattern from [docs/integration-guide.md](../../docs/integration-guide.md) §4.

It exists to prove one property: **tokens never reach the browser.** The browser only ever holds
an opaque, `HttpOnly` session id; every token lives in the server-side session.

## What it demonstrates

| Concern                                | Where it lives                                                              |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `state`, `nonce`, PKCE `code_verifier` | server-side login transaction (`src/store.ts`)                              |
| Single-use `state`                     | `takeTransaction()` deletes on read; a replayed or forged state is rejected |
| Tokens                                 | server-side session, never serialised into HTML, JSON or the URL            |
| Session cookie                         | `bff_session`, `HttpOnly`, `SameSite=Lax`, `Secure` when the IdP is HTTPS   |
| Access-token use                       | `GET /oauth2/userinfo` called server-to-server                              |
| Refresh                                | rotation with the refresh token that never leaves the server                |
| Logout                                 | refresh token revoked at the IdP, session deleted, cookie cleared           |
| Failure path                           | `/signin-failed` with the reason and a link to the Hosted sign-in page      |

## Endpoints

| Route                | Purpose                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `GET /`              | Profile page; redirects to `/login` without a session             |
| `GET /login`         | Creates the transaction and redirects to `/oauth2/authorize`      |
| `GET /auth/callback` | Validates `state`, exchanges the code, creates the session        |
| `POST /refresh`      | Rotates the tokens for the current session                        |
| `POST /logout`       | Revokes the refresh token and destroys the session                |
| `GET /api/session`   | JSON with `authenticated`, `expiresAt` and the claims (no tokens) |
| `GET /healthz`       | Liveness probe used by Playwright                                 |

## Running it locally

The IdP must be reachable, and the client must be registered with the callback URI:

```powershell
pnpm --filter @idpn/api run seed:e2e          # registers `sample-bff` + `user@example.com`
$env:IDP_URL='http://127.0.0.1:3100'
$env:HOSTED_UI_URL='http://127.0.0.1:5180'
$env:BFF_CLIENT_ID='sample-bff'
$env:BFF_CLIENT_SECRET='e2e-bff-client-secret'
$env:BFF_PORT='3200'
pnpm --filter @idpn/example-bff run dev
```

| Variable                | Default                               | Meaning                                      |
| ----------------------- | ------------------------------------- | -------------------------------------------- |
| `IDP_URL`               | — (required)                          | Issuer origin; endpoints are derived from it |
| `BFF_CLIENT_ID`         | — (required)                          | Confidential client id                       |
| `BFF_CLIENT_SECRET`     | — (required)                          | Client secret (`client_secret_basic`)        |
| `BFF_REDIRECT_URI`      | `${BFF_PUBLIC_URL}/auth/callback`     | Registered callback                          |
| `BFF_SCOPES`            | `openid profile email offline_access` | Requested scopes                             |
| `BFF_PORT` / `BFF_HOST` | `3200` / `127.0.0.1`                  | Listen address                               |
| `BFF_PUBLIC_URL`        | `http://${BFF_HOST}:${BFF_PORT}`      | Public origin of the sample                  |
| `BFF_COOKIE_SECURE`     | `true` when `BFF_PUBLIC_URL` is https | Force the `Secure` flag on BFF cookies      |
| `HOSTED_UI_URL`         | `${IDP_URL}/`                         | Fallback link on the failure page            |

## Tests

```powershell
pnpm --filter @idpn/example-bff run test         # unit/HTTP with an in-memory IdP
pnpm exec playwright test --project bff-chromium # full flow against the real API
```

`test/fake-idp.ts` validates PKCE, rotates refresh tokens and rejects reused codes, so the unit
suite covers the BFF's half of the contract without a database. The Playwright project then runs
the same flow through a real Chromium, the Hosted Auth UI, the API, PostgreSQL and Redis.

## Notes and limits

- Transactions and sessions are kept in memory: one process, lost on restart. A real platform
  stores them in Redis or PostgreSQL — the `BffStore` interface is the seam.
- Logout is local (RP session + token revocation). Ending the IdP single sign-on session needs
  RP-initiated logout (`end_session_endpoint`), which belongs to the logout-flow card.
- No consent screen is rendered: the IdP treats first-party clients as pre-consented.
