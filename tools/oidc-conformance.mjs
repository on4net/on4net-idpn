#!/usr/bin/env node
/**
 * Local OIDC conformance-style checks (docs/auth-flows.md 2, docs/security.md 13).
 *
 * The OpenID Foundation Conformance Suite needs a browser automation runner; this script
 * covers the protocol invariants that can be checked over plain HTTP against a running API
 * without a user session:
 *
 *   - discovery metadata (issuer, ES256 only, S256 only, no implicit/password grants);
 *   - JWKS shape and that no private key material is published;
 *   - /authorize negative cases: exact redirect_uri match, mandatory PKCE (S256), state,
 *     nonce, response_type, unknown client;
 *   - /token error codes: invalid_client, unsupported_grant_type, invalid_grant;
 *   - /userinfo requires a bearer token.
 *
 * Usage:
 *   node tools/oidc-conformance.mjs \
 *     --base http://127.0.0.1:3100 \
 *     --client probe-client \
 *     --redirect https://probe.example.com/cb \
 *     --token-client <public-spa-or-mobile-client>
 *
 * `--client`/`--redirect` must name a registered client used for the `/authorize` checks.
 * `--token-client` must be a public client (`type` spa/mobile, no secret) so the grant-level
 * error codes can be reached without client credentials.
 *
 * Exit code 0 = every check passed, 1 = at least one failure.
 */
import { createHash, randomBytes } from 'node:crypto';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const base = (args.get('--base') ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');
const clientId = args.get('--client') ?? 'probe-client';
const redirectUri = args.get('--redirect') ?? 'https://probe.example.com/cb';
/** A public client (`token_endpoint_auth_method=none`) so grant error codes can be reached. */
const tokenClientId = args.get('--token-client') ?? 'sample-bff-b';

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(12).toString('base64url');
const nonce = randomBytes(12).toString('base64url');

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
};

const same = (name, actual, expected) =>
  record(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

function oauthError(response, body) {
  if (response.status === 302 || response.status === 303) {
    const location = response.headers.get('location');
    if (location === null) {
      return null;
    }
    return new URL(location, base).searchParams.get('error');
  }
  if (body !== undefined && typeof body === 'object' && body !== null && 'error' in body) {
    return body.error;
  }
  return null;
}

async function get(path) {
  return fetch(`${base}${path}`, { redirect: 'manual' });
}

async function postForm(path, fields) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}

const baseAuthorize = {
  response_type: 'code',
  client_id: clientId,
  redirect_uri: redirectUri,
  scope: 'openid',
  state,
  nonce,
  code_challenge: challenge,
  code_challenge_method: 'S256',
};

const authorizeWith = (overrides = {}) => {
  const params = new URLSearchParams({ ...baseAuthorize, ...overrides });
  for (const [key, value] of [...params.entries()]) {
    if (value === '') {
      params.delete(key);
    }
  }
  return get(`/oauth2/authorize?${params.toString()}`);
};

// --- discovery ---------------------------------------------------------------
const discoveryResponse = await get('/.well-known/openid-configuration');
const discovery = await discoveryResponse.json().catch(() => null);
record(
  'discovery: 200 with JSON',
  discoveryResponse.status === 200 && discovery !== null,
  `status ${discoveryResponse.status}`,
);
if (discovery !== null) {
  same('discovery: issuer matches base', discovery.issuer, base);
  same('discovery: only ES256 for id_token', discovery.id_token_signing_alg_values_supported, [
    'ES256',
  ]);
  same('discovery: only S256 PKCE', discovery.code_challenge_methods_supported, ['S256']);
  same('discovery: response_types_supported is code', discovery.response_types_supported, ['code']);
  record(
    'discovery: no implicit or password grant',
    !(discovery.grant_types_supported ?? []).includes('implicit') &&
      !(discovery.grant_types_supported ?? []).includes('password'),
    JSON.stringify(discovery.grant_types_supported),
  );
  record(
    'discovery: endpoints are absolute and on the issuer',
    ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'userinfo_endpoint'].every(
      (key) => typeof discovery[key] === 'string' && discovery[key].startsWith(base),
    ),
    JSON.stringify(discovery),
  );
}

// --- JWKS --------------------------------------------------------------------
const jwksResponse = await get('/.well-known/jwks.json');
const jwks = await jwksResponse.json().catch(() => null);
record(
  'jwks: 200 with keys',
  jwksResponse.status === 200 && Array.isArray(jwks?.keys) && jwks.keys.length > 0,
  `status ${jwksResponse.status}`,
);
const signingKey = jwks?.keys?.[0];
record(
  'jwks: ES256 P-256 signing key with kid',
  signingKey?.kty === 'EC' &&
    signingKey?.crv === 'P-256' &&
    signingKey?.alg === 'ES256' &&
    typeof signingKey?.kid === 'string',
  JSON.stringify(signingKey),
);
record(
  'jwks: publishes no private key material',
  jwks?.keys?.every((key) => key.d === undefined) === true,
  'a key contains "d"',
);

// --- /oauth2/authorize --------------------------------------------------------
const validRequest = await authorizeWith();
record(
  'authorize: a valid request redirects to login (no error)',
  validRequest.status === 302 && oauthError(validRequest) === null,
  `status ${validRequest.status} location ${validRequest.headers.get('location')}`,
);

const missingPkce = await authorizeWith({ code_challenge: '', code_challenge_method: '' });
same('authorize: missing PKCE is invalid_request', oauthError(missingPkce), 'invalid_request');

const plainPkce = await authorizeWith({ code_challenge_method: 'plain' });
same('authorize: plain PKCE is rejected', oauthError(plainPkce), 'invalid_request');

const missingState = await authorizeWith({ state: '' });
same('authorize: missing state is invalid_request', oauthError(missingState), 'invalid_request');

const missingNonce = await authorizeWith({ nonce: '' });
same('authorize: missing nonce is invalid_request', oauthError(missingNonce), 'invalid_request');

const implicit = await authorizeWith({ response_type: 'token' });
same(
  'authorize: implicit response_type is unsupported',
  oauthError(implicit),
  'unsupported_response_type',
);

const unregistered = await get(
  `/oauth2/authorize?${new URLSearchParams({ ...baseAuthorize, redirect_uri: redirectUri + '.evil.example' })}`,
);
const unregisteredBody = await unregistered.json().catch(() => null);
record(
  'authorize: unregistered redirect_uri is a 400, never a redirect',
  unregistered.status === 400 && oauthError(unregistered, unregisteredBody) === 'invalid_request',
  `status ${unregistered.status} location ${unregistered.headers.get('location')}`,
);

const wildcard = await get(
  `/oauth2/authorize?${new URLSearchParams({ ...baseAuthorize, redirect_uri: `${new URL(redirectUri).origin}/*` })}`,
);
const wildcardBody = await wildcard.json().catch(() => null);
record(
  'authorize: wildcard redirect_uri is rejected',
  wildcard.status === 400 && oauthError(wildcard, wildcardBody) === 'invalid_request',
  `status ${wildcard.status}`,
);

const unknownClient = await get(
  `/oauth2/authorize?${new URLSearchParams({ ...baseAuthorize, client_id: 'conformance-unknown-client' })}`,
);
const unknownClientBody = await unknownClient.json().catch(() => null);
same(
  'authorize: unknown client is unauthorized_client',
  oauthError(unknownClient, unknownClientBody),
  'unauthorized_client',
);

// --- /oauth2/token -------------------------------------------------------------
const unknownClientToken = await postForm('/oauth2/token', {
  grant_type: 'authorization_code',
  client_id: 'conformance-unknown-client',
  code: 'invalid-code',
  redirect_uri: redirectUri,
  code_verifier: verifier,
});
const unknownClientTokenBody = await unknownClientToken.json().catch(() => null);
same(
  'token: unknown client is invalid_client',
  oauthError(unknownClientToken, unknownClientTokenBody),
  'invalid_client',
);

const passwordGrant = await postForm('/oauth2/token', {
  grant_type: 'password',
  client_id: tokenClientId,
  username: 'conformance',
  password: 'conformance',
});
const passwordGrantBody = await passwordGrant.json().catch(() => null);
same(
  'token: password grant is unsupported',
  oauthError(passwordGrant, passwordGrantBody),
  'unsupported_grant_type',
);

const invalidCode = await postForm('/oauth2/token', {
  grant_type: 'authorization_code',
  client_id: tokenClientId,
  code: 'invalid-code',
  redirect_uri: redirectUri,
  code_verifier: verifier,
});
const invalidCodeBody = await invalidCode.json().catch(() => null);
same(
  'token: invalid code is invalid_grant',
  oauthError(invalidCode, invalidCodeBody),
  'invalid_grant',
);

// --- /oauth2/userinfo -----------------------------------------------------------
const userinfo = await get('/oauth2/userinfo');
record(
  'userinfo: requires a bearer token',
  userinfo.status === 401 && userinfo.headers.get('www-authenticate') !== null,
  `status ${userinfo.status}`,
);

// --- summary --------------------------------------------------------------------
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log(
    `\nFailed checks:\n${failed.map((result) => `- ${result.name}: ${result.detail}`).join('\n')}`,
  );
  process.exitCode = 1;
}
