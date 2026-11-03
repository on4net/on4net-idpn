import { expect, test } from '@playwright/test';

const guardedPaths = [
  '/api/v1/me',
  '/api/v1/users',
  '/api/v1/users/00000000-0000-0000-0000-000000000000',
];

test.describe('Admin API exposure', () => {
  test('requires a bearer token for every user endpoint', async ({ request }) => {
    for (const path of guardedPaths) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(401);
      expect(response.headers()['www-authenticate']).toContain('Bearer');
    }
  });

  test('rejects a forged token with 401 and an RFC 9457 problem', async ({ request }) => {
    const response = await request.get('/api/v1/users', {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    expect(response.status()).toBe(401);
    const body = (await response.json()) as { type?: string; status?: number };
    expect(body.type).toContain('/unauthorized');
    expect(body.status).toBe(401);
  });

  test('rejects an unauthenticated create without touching the database', async ({ request }) => {
    const response = await request.post('/api/v1/users', {
      data: { username: 'e2eanon', email: 'e2eanon@example.com', displayName: 'Anon' },
    });
    expect(response.status()).toBe(401);
    const body = (await response.json()) as { type?: string };
    expect(body.type).toContain('/unauthorized');
  });
});
