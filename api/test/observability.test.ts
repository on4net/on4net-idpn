import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  AuthorizationCodeRecord,
  AuthorizationCodeRepository,
} from '../src/oidc/authorization-code.js';
import type { ClientAuthRepository } from '../src/oidc/client-auth.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import type { RefreshTokenRecord, RefreshTokenRepository } from '../src/oidc/refresh-token.js';
import type { UserProfileRepository } from '../src/oidc/token-claims.js';
import { DependencyMonitor } from '../src/observability/health.js';
import { ApiMetrics } from '../src/observability/metrics.js';
import { buildServer } from '../src/server.js';

const METRICS_TOKEN = 'metrics-test-token-0123456789';

const clients: ClientAuthRepository = {
  async findForAuth() {
    return null;
  },
};

const codes: AuthorizationCodeRepository = {
  async create(_record: AuthorizationCodeRecord) {
    return undefined;
  },
  async findByHash() {
    return null;
  },
  async markConsumed() {
    return false;
  },
};

const refreshTokens: RefreshTokenRepository = {
  async create(_record: RefreshTokenRecord) {
    return undefined;
  },
  async findByHash() {
    return null;
  },
  async markRotated() {
    return false;
  },
  async revokeFamily() {
    return 0;
  },
  async revokeByHash() {
    return false;
  },
};

const users: UserProfileRepository = {
  async findProfile() {
    return null;
  },
};

const keys = new SigningKeyManager(new MemorySigningKeyRepository());

function buildObservedServer(options: { token?: string } = {}) {
  const metrics = new ApiMetrics();
  const readiness = new DependencyMonitor({
    probes: [
      { name: 'postgres', check: async () => undefined },
      { name: 'redis', check: async () => 'PONG' },
    ],
    timeoutMs: 100,
  });
  const app = buildServer({
    issuer: 'https://auth.example.com',
    keys,
    readiness,
    metrics: {
      metrics,
      ...(options.token === undefined ? {} : { token: options.token }),
      collect: async () => {
        metrics.dependencyUp.set({ service: 'postgres' }, 1);
        metrics.dependencyUp.set({ service: 'redis' }, 1);
        metrics.activeSessions.set({}, 7);
      },
    },
    token: { clients, codes, refreshTokens, users },
  });
  return { app, metrics };
}

describe('GET /metrics', () => {
  const { app } = buildObservedServer({ token: METRICS_TOKEN });

  beforeAll(async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires the configured bearer token', async () => {
    await request(app.server).get('/metrics').expect(401);
    await request(app.server)
      .get('/metrics')
      .set('Authorization', 'Bearer wrong-token')
      .expect(401);
    const authorized = await request(app.server)
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      .expect(200);

    expect(String(authorized.headers['content-type'])).toContain('text/plain; version=0.0.4');
    expect(authorized.headers['cache-control']).toBe('no-store');
    expect(authorized.text).toContain('idpn_auth_failures_total');
  });

  it('exposes request, dependency and gauge families in Prometheus format', async () => {
    await request(app.server)
      .get('/.well-known/openid-configuration?access_token=SECRET-VALUE')
      .expect(200);
    await request(app.server).get('/healthz').expect(200);

    const response = await request(app.server)
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      .expect(200);

    expect(response.text).toContain(
      'idpn_http_requests_total{method="GET",route="/.well-known/openid-configuration",status="200"} 1',
    );
    expect(response.text).toContain('idpn_http_request_duration_seconds_bucket');
    expect(response.text).toContain('idpn_dependency_up{service="postgres"} 1');
    expect(response.text).toContain('idpn_dependency_up{service="redis"} 1');
    expect(response.text).toContain('idpn_active_sessions 7');
    expect(response.text).toContain('idpn_metrics_series_dropped_total 0');
    // Health and scrape endpoints are excluded from SLO metrics, and query strings never
    // become labels.
    expect(response.text).not.toContain('route="/healthz"');
    expect(response.text).not.toContain('route="/metrics",status=');
    expect(response.text).not.toContain('SECRET-VALUE');
  });

  it('counts token endpoint client failures as auth failures', async () => {
    await request(app.server)
      .post('/oauth2/token')
      .type('form')
      .send({ grant_type: 'refresh_token', client_id: 'unknown', refresh_token: 'x' })
      .expect(401);

    const response = await request(app.server)
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      .expect(200);
    expect(response.text).toContain(
      'idpn_auth_failures_total{reason="invalid_client",route="/oauth2/token"} 1',
    );
    expect(response.text).toContain(
      'idpn_token_requests_total{grant_type="refresh_token",result="error"} 1',
    );
  });

  it('echoes a valid request id and replaces an untrusted one', async () => {
    const accepted = await request(app.server)
      .get('/healthz')
      .set('X-Request-Id', 'req-1234-abcd')
      .expect(200);
    expect(accepted.headers['x-request-id']).toBe('req-1234-abcd');

    const rejected = await request(app.server)
      .get('/healthz')
      .set('X-Request-Id', 'bad id')
      .expect(200);
    expect(rejected.headers['x-request-id']).not.toBe('bad id');
    expect(String(rejected.headers['x-request-id'])).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  });
});

describe('GET /metrics without a token', () => {
  const { app } = buildObservedServer();

  beforeAll(async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the scrape to the internal network when no token is configured', async () => {
    const response = await request(app.server).get('/metrics').expect(200);
    expect(response.text).toContain('# TYPE idpn_http_requests_total counter');
  });
});

describe('GET /readyz', () => {
  it('returns 200 when PostgreSQL and Redis answer', async () => {
    const { app } = buildObservedServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const response = await request(app.server).get('/readyz').expect(200);
      expect(response.body).toMatchObject({
        status: 'ok',
        service: 'on4net-idpn-api',
        checks: [
          { name: 'postgres', status: 'ok' },
          { name: 'redis', status: 'ok' },
        ],
      });
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      await app.close();
    }
  });

  it('returns 503 when a dependency is down', async () => {
    const app = buildServer({
      issuer: 'https://auth.example.com',
      keys,
      readiness: new DependencyMonitor({
        probes: [
          { name: 'postgres', check: async () => undefined },
          {
            name: 'redis',
            check: async () => {
              throw new Error('ECONNREFUSED 127.0.0.1:6379');
            },
          },
        ],
        timeoutMs: 100,
      }),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const response = await request(app.server).get('/readyz').expect(503);
      expect(response.body).toMatchObject({
        status: 'degraded',
        checks: [
          { name: 'postgres', status: 'ok' },
          { name: 'redis', status: 'down' },
        ],
      });
      expect(JSON.stringify(response.body)).toContain('ECONNREFUSED');
    } finally {
      await app.close();
    }
  });

  it('returns 503 and does not hang when a probe times out', async () => {
    const app = buildServer({
      issuer: 'https://auth.example.com',
      keys,
      readiness: new DependencyMonitor({
        probes: [{ name: 'postgres', check: () => new Promise(() => undefined) }],
        timeoutMs: 20,
      }),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const startedAt = Date.now();
      const response = await request(app.server).get('/readyz').expect(503);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(response.body.checks[0]).toMatchObject({ name: 'postgres', status: 'down' });
      expect(response.body.checks[0].error).toContain('timed out');
    } finally {
      await app.close();
    }
  });
});
