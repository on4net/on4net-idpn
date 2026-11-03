// k6 global: scenario configuration is read from environment variables.
/* global __ENV */

// k6 load profile for the on4net IDPN critical paths (issue #47).
//
// Scenarios with explicit thresholds:
//   - public discovery and JWKS (cache target: p95 < 50ms, docs/testing.md 10)
//   - SSO authorize from an existing session
//   - authorization_code exchange and refresh-token rotation (token target: p95 < 300ms)
//   - password login (target: p95 < 800ms)
//   - userinfo, Admin API lists and the public translation bundle
//
// Profiles:
//   PROFILE=smoke  short CI run (~20s per scenario)
//   PROFILE=full   release run (DURATION=300 by default)
//
// The API under test must be started with the fixtures from `pnpm perf:seed` and
// `ADMIN_CLIENT_ID=perf-admin`; see tools/perf/README.md.
//
// Concurrency is each scenario's `preAllocatedVUs`/`maxVUs` (constant-arrival-rate keeps a
// fixed request rate and bounds the workers). Every request is tagged so thresholds can be
// evaluated per scenario; authentication setup is tagged `auth_setup` and excluded.

import http from 'k6/http';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { check, fail } from 'k6';

const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '');
const USER_IDENTIFIER = __ENV.PERF_USER_IDENTIFIER || 'perf@example.com';
const USER_PASSWORD = __ENV.PERF_USER_PASSWORD || 'perf-user-password-123';
const ADMIN_CLIENT_ID = __ENV.PERF_ADMIN_CLIENT_ID || 'perf-admin';
const ADMIN_CLIENT_SECRET = __ENV.PERF_ADMIN_CLIENT_SECRET || 'perf-admin-client-secret';
const APP_CLIENT_ID = __ENV.PERF_APP_CLIENT_ID || 'perf-app';
const ADMIN_REDIRECT_URI = __ENV.PERF_REDIRECT_URI || 'http://127.0.0.1:3999/callback';
const APP_REDIRECT_URI = __ENV.PERF_SSO_REDIRECT_URI || 'http://127.0.0.1:3998/callback';
const BUNDLE_CLIENT_ID = __ENV.PERF_BUNDLE_CLIENT_ID || 'perf-app';
const MFE_BUNDLE_URL = (__ENV.MFE_BUNDLE_URL || '').trim();
const ADMIN_SCOPE = 'openid profile email idp.admin offline_access';
const APP_SCOPE = 'openid profile email offline_access';

const PROFILE = __ENV.PROFILE || 'smoke';
const SMOKE = PROFILE !== 'full';
const DURATION = Number(__ENV.DURATION || (SMOKE ? 15 : 300));
const WARMUP_SECONDS = 5;
/** Optional comma-separated subset (e.g. ONLY=jwks,token_refresh) for isolation runs. */
const ONLY = (__ENV.ONLY || '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value !== '');

/**
 * Request rates per second; the full profile roughly doubles public traffic. `RATE_SCALE`
 * multiplies every scenario for a capacity run (e.g. RATE_SCALE=5 ONLY=jwks).
 */
const BASE_RATE = SMOKE
  ? {
      discovery: 100,
      jwks: 150,
      authorize: 30,
      token_exchange: 5,
      token_refresh: 5,
      login: 1,
      userinfo: 100,
      admin_users: 30,
      admin_audit: 30,
      bundle: 100,
      mfe_remote: 100,
    }
  : {
      discovery: 200,
      jwks: 300,
      authorize: 60,
      token_exchange: 10,
      token_refresh: 10,
      login: 2,
      userinfo: 200,
      admin_users: 50,
      admin_audit: 50,
      bundle: 200,
      mfe_remote: 200,
    };

const RATE_SCALE = Number(__ENV.RATE_SCALE || 1);
const RATE = Object.fromEntries(
  Object.entries(BASE_RATE).map(([name, rate]) => [
    name,
    Math.max(1, Math.round(rate * RATE_SCALE)),
  ]),
);

/**
 * `http_reqs` rate thresholds average over the whole run, which includes the warmup window.
 * Discount the warmup and allow 20% headroom; a scenario that silently stops still fails.
 */
const rateFloor = (rate) =>
  Math.max(0.5, Number((rate * (DURATION / (DURATION + WARMUP_SECONDS)) * 0.8).toFixed(2)));

const arrival = (rate, options = {}) => {
  const preAllocatedVUs = options.preAllocatedVUs ?? Math.max(2, Math.ceil(rate / 10));
  return {
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    duration: `${DURATION}s`,
    startTime: `${WARMUP_SECONDS}s`,
    preAllocatedVUs,
    maxVUs: Math.max(preAllocatedVUs, options.maxVUs ?? Math.max(4, Math.ceil(rate / 4))),
    gracefulStop: '5s',
  };
};

const durationThreshold = (name, p95, p99) => ({
  [`http_req_duration{name:${name}}`]: [`p(95)<${p95}`, `p(99)<${p99}`],
});

const ALL_SCENARIOS = {
  warmup: {
    executor: 'constant-vus',
    exec: 'warmup',
    vus: 2,
    duration: `${WARMUP_SECONDS}s`,
  },
  discovery: { ...arrival(RATE.discovery, { maxVUs: 60 }), exec: 'discovery' },
  jwks: { ...arrival(RATE.jwks, { maxVUs: 80 }), exec: 'jwks' },
  // Auth scenarios need extra VUs: each VU performs one login (Argon2) before its first
  // measured request, so the pool must absorb the cold-start setup without dropping the
  // fixed arrival rate.
  authorize: {
    ...arrival(RATE.authorize, { preAllocatedVUs: 10, maxVUs: 60 }),
    exec: 'authorizeSso',
  },
  token_exchange: {
    ...arrival(RATE.token_exchange, { preAllocatedVUs: 8, maxVUs: 60 }),
    exec: 'tokenExchange',
  },
  token_refresh: {
    // Each VU owns one refresh family from the setup pool; the pool is the VU ceiling.
    ...arrival(RATE.token_refresh, { preAllocatedVUs: 8, maxVUs: 32 }),
    exec: 'tokenRefresh',
  },
  login: { ...arrival(RATE.login, { maxVUs: 10 }), exec: 'passwordLogin' },
  userinfo: { ...arrival(RATE.userinfo, { preAllocatedVUs: 10, maxVUs: 40 }), exec: 'userinfo' },
  admin_users: {
    ...arrival(RATE.admin_users, { preAllocatedVUs: 8, maxVUs: 40 }),
    exec: 'adminUsers',
  },
  admin_audit: {
    ...arrival(RATE.admin_audit, { preAllocatedVUs: 8, maxVUs: 40 }),
    exec: 'adminAudit',
  },
  bundle: { ...arrival(RATE.bundle, { maxVUs: 60 }), exec: 'bundle' },
  // Only mounted when MFE_BUNDLE_URL points at a running remote server (release profile).
  ...(MFE_BUNDLE_URL === ''
    ? {}
    : { mfe_remote: { ...arrival(RATE.mfe_remote, { maxVUs: 60 }), exec: 'mfeRemote' } }),
};

/** Request tags each scenario produces; used to keep thresholds consistent with ONLY. */
const REQUESTS_BY_SCENARIO = {
  warmup: ['warmup'],
  discovery: ['discovery'],
  jwks: ['jwks'],
  authorize: ['authorize_sso'],
  // The exchange scenario also authorizes, tagged `authorize_for_token`.
  token_exchange: ['authorize_for_token', 'token_exchange'],
  token_refresh: ['token_refresh'],
  login: ['login'],
  userinfo: ['userinfo'],
  admin_users: ['admin_users'],
  admin_audit: ['admin_audit'],
  bundle: ['bundle'],
  mfe_remote: ['mfe_remote'],
};

const selectedScenarios = Object.keys(ALL_SCENARIOS).filter(
  (name) => ONLY.length === 0 || ONLY.includes(name),
);
const selectedRequests = new Set(
  selectedScenarios.flatMap((name) => REQUESTS_BY_SCENARIO[name] ?? []),
);

const ALL_THRESHOLDS = {
  checks: ['rate>0.99'],
  http_req_failed: ['rate<0.01'],
  dropped_iterations: ['count==0'],
  ...durationThreshold('discovery', 100, 250),
  ...durationThreshold('jwks', 50, 150),
  ...durationThreshold('authorize_sso', 150, 400),
  ...durationThreshold('token_exchange', 300, 750),
  ...durationThreshold('token_refresh', 300, 750),
  ...durationThreshold('login', 800, 1600),
  ...durationThreshold('userinfo', 150, 400),
  ...durationThreshold('admin_users', 300, 750),
  ...durationThreshold('admin_audit', 300, 750),
  ...durationThreshold('bundle', 100, 250),
  ...(MFE_BUNDLE_URL === '' ? {} : durationThreshold('mfe_remote', 100, 250)),
  // Achieved throughput floors keep a "fast because nothing ran" result from passing.
  [`http_reqs{name:discovery}`]: [`rate>=${rateFloor(RATE.discovery)}`],
  [`http_reqs{name:jwks}`]: [`rate>=${rateFloor(RATE.jwks)}`],
  [`http_reqs{name:authorize_sso}`]: [`rate>=${rateFloor(RATE.authorize)}`],
  [`http_reqs{name:token_exchange}`]: [`rate>=${rateFloor(RATE.token_exchange)}`],
  [`http_reqs{name:token_refresh}`]: [`rate>=${rateFloor(RATE.token_refresh)}`],
  [`http_reqs{name:login}`]: [`rate>=${rateFloor(RATE.login)}`],
  [`http_reqs{name:userinfo}`]: [`rate>=${rateFloor(RATE.userinfo)}`],
  [`http_reqs{name:admin_users}`]: [`rate>=${rateFloor(RATE.admin_users)}`],
  [`http_reqs{name:admin_audit}`]: [`rate>=${rateFloor(RATE.admin_audit)}`],
  [`http_reqs{name:bundle}`]: [`rate>=${rateFloor(RATE.bundle)}`],
  ...(MFE_BUNDLE_URL === ''
    ? {}
    : { [`http_reqs{name:mfe_remote}`]: [`rate>=${rateFloor(RATE.mfe_remote)}`] }),
};

const selectedThresholds = Object.fromEntries(
  Object.entries(ALL_THRESHOLDS).filter(([key]) => {
    const match = /name:([a-z_]+)/.exec(key);
    return match === null || selectedRequests.has(match[1]);
  }),
);

/**
 * k6 provisions a scenario's VUs when it starts. With every arrival scenario starting at the
 * same instant, a shared CI runner occasionally cannot initialise ~90 VUs fast enough and the
 * arrival executor drops a single iteration — a client-side artefact that fails the
 * `dropped_iterations == 0` SLO without any server-side degradation. Staggering the starts by
 * 250 ms removes that spike; rates, durations and thresholds are untouched.
 */
const SCENARIO_STAGGER_SECONDS = 0.25;

const staggerScenarios = () =>
  Object.fromEntries(
    selectedScenarios.map((name, index) => {
      const scenario = ALL_SCENARIOS[name];
      if (name === 'warmup' || index === 0) {
        return [name, scenario];
      }
      return [
        name,
        { ...scenario, startTime: `${WARMUP_SECONDS + (index - 1) * SCENARIO_STAGGER_SECONDS}s` },
      ];
    }),
  );

export const options = {
  // k6 clears the VU cookie jar between iterations by default; a session must survive so the
  // authorize/SSO scenarios exercise a real SSO session instead of a fresh login.
  noCookiesReset: true,
  scenarios: staggerScenarios(),
  thresholds: selectedThresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const formHeaders = (clientId, clientSecret) => ({
  'Content-Type': 'application/x-www-form-urlencoded',
  Authorization: `Basic ${encoding.b64encode(`${clientId}:${clientSecret}`, 'std')}`,
});

const sessionHeader = (sessionId) => ({ Cookie: `idpn_session=${sessionId}` });

const randomVerifier = () => encoding.b64encode(crypto.randomBytes(32), 'rawurl');
const challengeFor = (verifier) => encoding.b64encode(crypto.sha256(verifier, 'binary'), 'rawurl');

const login = (clientId) => {
  const response = http.post(
    `${BASE_URL}/api/v1/login`,
    JSON.stringify({ identifier: USER_IDENTIFIER, password: USER_PASSWORD, clientId }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'auth_setup' },
    },
  );
  if (response.status !== 200) {
    fail(`login failed: ${response.status} ${response.body}`);
  }
  const cookie = response.cookies['idpn_session']?.[0]?.value;
  if (typeof cookie !== 'string' || cookie === '') {
    fail('login did not return an idpn_session cookie');
  }
  return { response, sessionId: cookie };
};

const authorize = (clientId, redirectUri, scope, tags, sessionId) => {
  const verifier = randomVerifier();
  const query = [
    'response_type=code',
    `client_id=${encodeURIComponent(clientId)}`,
    `redirect_uri=${encodeURIComponent(redirectUri)}`,
    `scope=${encodeURIComponent(scope)}`,
    'state=perf-state',
    'nonce=perf-nonce',
    `code_challenge=${challengeFor(verifier)}`,
    'code_challenge_method=S256',
  ].join('&');
  const response = http.get(`${BASE_URL}/oauth2/authorize?${query}`, {
    redirects: 0,
    headers: sessionId === undefined ? {} : sessionHeader(sessionId),
    tags,
  });
  const location = response.headers['Location'] || '';
  const code = /[?&]code=([^&]+)/.exec(location);
  check(response, {
    'authorize redirects with a code': () =>
      response.status === 302 && code !== null && !location.includes('error='),
  });
  if (response.status !== 302 || code === null) {
    fail(`authorize failed: ${response.status} ${location} ${response.body}`);
  }
  return { verifier, code: decodeURIComponent(code[1]) };
};

const exchange = (clientId, clientSecret, redirectUri, scope, tags, sessionId) => {
  const { verifier, code } = authorize(
    clientId,
    redirectUri,
    scope,
    {
      name: 'authorize_for_token',
    },
    sessionId,
  );
  const response = http.post(
    `${BASE_URL}/oauth2/token`,
    `grant_type=authorization_code&code=${encodeURIComponent(code)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&code_verifier=${encodeURIComponent(verifier)}`,
    {
      headers: formHeaders(clientId, clientSecret),
      tags,
    },
  );
  check(response, { 'token exchange returns 200': (r) => r.status === 200 });
  if (response.status !== 200) {
    fail(`token exchange failed: ${response.status} ${response.body}`);
  }
  return response.json();
};

const refresh = (refreshToken, tags) => {
  const response = http.post(
    `${BASE_URL}/oauth2/token`,
    `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    {
      headers: formHeaders(ADMIN_CLIENT_ID, ADMIN_CLIENT_SECRET),
      tags,
    },
  );
  check(response, { 'refresh returns 200': (r) => r.status === 200 });
  return response.status === 200 ? response.json() : null;
};

const bearer = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

/** Scenarios that need the authenticated fixture session/token from setup(). */
const AUTH_SCENARIOS = new Set([
  'authorize',
  'token_exchange',
  'token_refresh',
  'userinfo',
  'admin_users',
  'admin_audit',
]);

const needsAuth = selectedScenarios.some((name) => AUTH_SCENARIOS.has(name));

/**
 * Creates the shared fixtures once: one admin session cookie and one read-only access token.
 * Sessions and tokens are reused instead of logging in per VU, so the measured windows are
 * not dominated by Argon2 cold starts. The refresh scenario still owns one independent
 * refresh-token family per VU, created lazily on that VU's first iteration.
 *
 * Public-only runs (for example `ONLY=jwks,mfe_remote`) skip the API entirely.
 */
export function setup() {
  if (!needsAuth) {
    return { sessionId: '', accessToken: '' };
  }
  const { sessionId } = login(ADMIN_CLIENT_ID);
  const tokens = exchange(
    ADMIN_CLIENT_ID,
    ADMIN_CLIENT_SECRET,
    ADMIN_REDIRECT_URI,
    ADMIN_SCOPE,
    { name: 'auth_setup' },
    sessionId,
  );
  return { sessionId, accessToken: tokens.access_token };
}

export function warmup() {
  http.get(`${BASE_URL}/.well-known/openid-configuration`, { tags: { name: 'warmup' } });
  http.get(`${BASE_URL}/.well-known/jwks.json`, { tags: { name: 'warmup' } });
  http.get(`${BASE_URL}/api/v1/clients/${BUNDLE_CLIENT_ID}/translations/bundle?locale=fa-IR`, {
    tags: { name: 'warmup' },
  });
}

export function discovery() {
  const response = http.get(`${BASE_URL}/.well-known/openid-configuration`, {
    tags: { name: 'discovery' },
  });
  check(response, { 'discovery returns 200': (r) => r.status === 200 });
}

export function jwks() {
  const response = http.get(`${BASE_URL}/.well-known/jwks.json`, { tags: { name: 'jwks' } });
  check(response, {
    'jwks returns one key': (r) => r.status === 200 && (r.json('keys') || []).length >= 1,
  });
}

export function authorizeSso(data) {
  authorize(APP_CLIENT_ID, APP_REDIRECT_URI, APP_SCOPE, { name: 'authorize_sso' }, data.sessionId);
}

export function tokenExchange(data) {
  exchange(
    ADMIN_CLIENT_ID,
    ADMIN_CLIENT_SECRET,
    ADMIN_REDIRECT_URI,
    ADMIN_SCOPE,
    { name: 'token_exchange' },
    data.sessionId,
  );
}

/** Per-VU refresh-token family; created on the VU's first measured iteration. */
let vuRefreshToken = null;

export function tokenRefresh(data) {
  if (vuRefreshToken === null) {
    const tokens = exchange(
      ADMIN_CLIENT_ID,
      ADMIN_CLIENT_SECRET,
      ADMIN_REDIRECT_URI,
      ADMIN_SCOPE,
      { name: 'auth_setup' },
      data.sessionId,
    );
    vuRefreshToken = tokens.refresh_token ?? null;
  }
  if (vuRefreshToken === null) {
    fail('no refresh token available');
  }
  const tokens = refresh(vuRefreshToken, { name: 'token_refresh' });
  if (tokens !== null && tokens.refresh_token !== undefined) {
    vuRefreshToken = tokens.refresh_token;
  }
}

export function passwordLogin() {
  const response = http.post(
    `${BASE_URL}/api/v1/login`,
    JSON.stringify({
      identifier: USER_IDENTIFIER,
      password: USER_PASSWORD,
      clientId: ADMIN_CLIENT_ID,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'login' },
    },
  );
  check(response, { 'password login returns 200': (r) => r.status === 200 });
}

export function userinfo(data) {
  const response = http.get(`${BASE_URL}/oauth2/userinfo`, {
    ...bearer(data.accessToken),
    tags: { name: 'userinfo' },
  });
  check(response, { 'userinfo returns 200': (r) => r.status === 200 });
}

export function adminUsers(data) {
  const response = http.get(`${BASE_URL}/api/v1/users?limit=25&page=1`, {
    ...bearer(data.accessToken),
    tags: { name: 'admin_users' },
  });
  check(response, {
    'admin user list returns 25 rows': (r) =>
      r.status === 200 && (r.json('items') || []).length === 25,
  });
}

export function adminAudit(data) {
  const response = http.get(`${BASE_URL}/api/v1/audit-events?limit=25&page=1`, {
    ...bearer(data.accessToken),
    tags: { name: 'admin_audit' },
  });
  check(response, { 'admin audit list returns 200': (r) => r.status === 200 });
}

export function bundle() {
  const response = http.get(
    `${BASE_URL}/api/v1/clients/${BUNDLE_CLIENT_ID}/translations/bundle?locale=fa-IR`,
    { tags: { name: 'bundle' } },
  );
  check(response, { 'bundle returns 200': (r) => r.status === 200 });
}

/**
 * Static MFE remote entry from a CDN/preview server (set `MFE_BUNDLE_URL`). This measures the
 * asset path the host browser uses; cache headers and the immutable version path are asserted
 * by the security tests and the deployment examples.
 */
export function mfeRemote() {
  const response = http.get(MFE_BUNDLE_URL, { tags: { name: 'mfe_remote' } });
  check(response, {
    'remote entry returns 200': (r) =>
      r.status === 200 && String(r.headers['Content-Type'] ?? '').includes('javascript'),
  });
}
