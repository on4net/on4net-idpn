import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

describe('external provider mocking (MSW)', () => {
  const server = setupServer(
    http.post('https://provider.example/oauth/token', () =>
      HttpResponse.json({ access_token: 'mocked-access-token', token_type: 'Bearer' }),
    ),
  );

  beforeAll(() => {
    server.listen({ onUnhandledFrame: 'error' });
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
  });

  it('intercepts an outbound provider request', async () => {
    const response = await fetch('https://provider.example/oauth/token', { method: 'POST' });

    await expect(response.json()).resolves.toEqual({
      access_token: 'mocked-access-token',
      token_type: 'Bearer',
    });
  });

  it('rejects requests that no handler mocks', async () => {
    await expect(fetch('https://unmocked.example/silent')).rejects.toThrow();
  });
});

describe('Redis test container', () => {
  let container: StartedRedisContainer | undefined;
  let redis: Redis;

  beforeAll(async () => {
    const externalRedis = process.env.TEST_REDIS_URL;
    if (externalRedis !== undefined && externalRedis !== '') {
      redis = new Redis(externalRedis);
    } else {
      container = await new RedisContainer('redis:7-alpine').withStartupTimeout(180_000).start();
      redis = new Redis(container.getConnectionUrl());
    }
  }, 300_000);

  afterAll(async () => {
    await redis?.del('idpn:test');
    await redis?.quit();
    await container?.stop();
  });

  it('accepts commands from the test process', async () => {
    await expect(redis.ping()).resolves.toBe('PONG');
    await redis.set('idpn:test', '1', 'EX', 30);
    await expect(redis.get('idpn:test')).resolves.toBe('1');
  });
});
