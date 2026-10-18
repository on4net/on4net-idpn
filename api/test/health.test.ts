import { healthResponseSchema } from '@idpn/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';

const app = buildServer();

beforeAll(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
});

describe('GET /healthz', () => {
  it('returns a payload that satisfies the published contract', async () => {
    const response = await request(app.server).get('/healthz').expect(200);

    expect(healthResponseSchema.parse(response.body)).toEqual({
      status: 'ok',
      service: 'on4net-idpn-api',
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('returns 404 for an unknown route', async () => {
    await request(app.server).get('/not-a-route').expect(404);
  });
});
