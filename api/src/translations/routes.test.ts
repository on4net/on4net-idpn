import { MESSAGES } from '@idpn/i18n';
import Fastify, { type FastifyInstance } from 'fastify';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createMemoryBundleCache } from './cache.js';
import { normalizeLocaleSettings } from './locale-settings.js';
import type { PublicTranslationClient } from './prisma-repository.js';
import { registerTranslationBundleRoute } from './routes.js';

const settings = normalizeLocaleSettings({
  default: 'fa-IR',
  supported: ['fa-IR', 'en-US'],
  calendar: 'persian',
  version: '2026-10-19T10:00:00.000Z',
});

function bundleApp(input: {
  client?: PublicTranslationClient | null;
  overrides?: Record<string, string>;
  cache?: ReturnType<typeof createMemoryBundleCache>;
}) {
  const calls = { clients: 0, overrides: 0 };
  const client =
    input.client === undefined
      ? { clientId: 'app-a', status: 'active' as const, settings }
      : input.client;
  const app: FastifyInstance = Fastify({ logger: false });
  registerTranslationBundleRoute(app, {
    repository: {
      async findClient() {
        calls.clients += 1;
        return client;
      },
      async findOverrides() {
        calls.overrides += 1;
        return input.overrides ?? {};
      },
    },
    ...(input.cache === undefined ? {} : { cache: input.cache }),
    allowedOrigins: async () => ['https://app-a.example.com'],
    now: () => Date.parse('2026-10-19T11:00:00.000Z'),
  });
  return { app, calls };
}

describe('GET /api/v1/clients/:clientId/translations/bundle', () => {
  it('merges overrides and emits cache metadata', async () => {
    const { app } = bundleApp({
      overrides: { 'login.title': 'ورود به پنل مشتریان' },
    });
    await app.ready();

    const response = await request(app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=fa-IR')
      .set('Origin', 'https://app-a.example.com')
      .expect(200);

    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.headers.etag).toBeDefined();
    expect(response.headers['last-modified']).toBe('Mon, 19 Oct 2026 10:00:00 GMT');
    expect(response.headers['access-control-allow-origin']).toBe('https://app-a.example.com');
    expect(response.body).toMatchObject({
      locale: 'fa-IR',
      dir: 'rtl',
      calendar: 'persian',
      version: '2026-10-19T10:00:00.000Z',
    });
    expect(response.body.messages['login.title']).toBe('ورود به پنل مشتریان');
    expect(response.body.messages['login.submit']).toBe(MESSAGES['fa-IR']['login.submit']);
    expect(JSON.stringify(response.body)).not.toContain('redirectUris');
    expect(JSON.stringify(response.body)).not.toContain('clientSecret');
    await app.close();
  });

  it('returns 304 for a matching ETag and serves the second request from cache', async () => {
    const cache = createMemoryBundleCache();
    const { app, calls } = bundleApp({ cache });
    await app.ready();

    const first = await request(app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=fa-IR')
      .expect(200);
    const overridesAfterFirst = calls.overrides;

    await request(app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=fa-IR')
      .set('If-None-Match', String(first.headers.etag))
      .expect(304);

    expect(calls.overrides).toBe(overridesAfterFirst);
    await app.close();
  });

  it('returns 304 for If-Modified-Since at or after the version', async () => {
    const { app } = bundleApp({});
    await app.ready();

    await request(app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=fa-IR')
      .set('If-Modified-Since', 'Mon, 19 Oct 2026 10:00:00 GMT')
      .expect(304);

    await app.close();
  });

  it('falls back to the client default when locale is omitted', async () => {
    const { app } = bundleApp({});
    await app.ready();
    const response = await request(app.server)
      .get('/api/v1/clients/app-a/translations/bundle')
      .expect(200);
    expect(response.body.locale).toBe('fa-IR');
    await app.close();
  });

  it('returns the same generic 404 for unknown, disabled or unsupported locales', async () => {
    const unknown = bundleApp({ client: null });
    await unknown.app.ready();
    const unknownResponse = await request(unknown.app.server)
      .get('/api/v1/clients/nope/translations/bundle?locale=fa-IR')
      .expect(404);
    expect(unknownResponse.body).toEqual({
      type: 'about:blank',
      title: 'Translations not found',
      status: 404,
    });
    await unknown.app.close();

    const disabled = bundleApp({
      client: { clientId: 'app-a', status: 'disabled', settings },
    });
    await disabled.app.ready();
    await request(disabled.app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=fa-IR')
      .expect(404);
    await disabled.app.close();

    const unsupported = bundleApp({});
    await unsupported.app.ready();
    const unsupportedResponse = await request(unsupported.app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=de-DE')
      .expect(404);
    expect(JSON.stringify(unsupportedResponse.body)).not.toContain('fa-IR');
    await unsupported.app.close();
  });
});

describe('bundle locale matching and conditional caching', () => {
  it.each([
    ['fa-ir', 'fa-IR', 'rtl'],
    ['FA-IR', 'fa-IR', 'rtl'],
    ['fa', 'fa-IR', 'rtl'],
    ['en', 'en-US', 'ltr'],
    ['EN-us', 'en-US', 'ltr'],
  ] as const)('matches locale=%s to %s', async (requested, expected, dir) => {
    const { app } = bundleApp({});
    await app.ready();

    const response = await request(app.server)
      .get(`/api/v1/clients/app-a/translations/bundle?locale=${requested}`)
      .expect(200);

    expect(response.body.locale).toBe(expected);
    expect(response.body.dir).toBe(dir);
    await app.close();
  });

  it.each([[''], ['*'], ['fa-IR*'], ['../fa-IR'], ['%3Cscript%3E']] as const)(
    'rejects the malformed locale query %s with the generic 404',
    async (requested) => {
      const { app } = bundleApp({});
      await app.ready();

      const response = await request(app.server)
        .get(`/api/v1/clients/app-a/translations/bundle?locale=${encodeURIComponent(requested)}`)
        .expect((resolved) => {
          if (requested === '') {
            expect(resolved.status).toBe(200);
          } else {
            expect(resolved.status).toBe(404);
          }
        });

      if (requested === '') {
        expect(response.body.locale).toBe('fa-IR');
      } else {
        expect(response.body).toEqual({
          type: 'about:blank',
          title: 'Translations not found',
          status: 404,
        });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers.etag).toBeUndefined();
      }
      await app.close();
    },
  );

  it('rejects a repeated locale parameter instead of guessing', async () => {
    const { app } = bundleApp({});
    await app.ready();

    await request(app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=fa-IR&locale=en-US')
      .expect(404);

    await app.close();
  });

  it('changes the ETag and body when an override is written', async () => {
    let overrides: Record<string, string> = {};
    let currentSettings = { ...settings };
    const app: FastifyInstance = Fastify({ logger: false });
    registerTranslationBundleRoute(app, {
      repository: {
        async findClient() {
          return { clientId: 'app-a', status: 'active' as const, settings: currentSettings };
        },
        async findOverrides() {
          return { ...overrides };
        },
      },
      now: () => Date.parse('2026-10-19T11:00:00.000Z'),
    });
    await app.ready();

    const first = await request(app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=fa-IR')
      .expect(200);
    expect(first.body.messages['login.title']).toBe(MESSAGES['fa-IR']['login.title']);

    overrides = { 'login.title': 'ورود به پنل مشتریان' };
    currentSettings = { ...settings, version: '2026-10-19T11:00:00.000Z' };
    const second = await request(app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=fa-IR')
      .expect(200);

    expect(second.body.messages['login.title']).toBe('ورود به پنل مشتریان');
    expect(second.headers.etag).not.toBe(first.headers.etag);
    expect(second.headers['last-modified']).toBe('Mon, 19 Oct 2026 11:00:00 GMT');
    expect(second.headers['cache-control']).toBe('public, max-age=300');

    // A conditional request based on the previous representation must revalidate to 200,
    // never serve the old override from the cache.
    await request(app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=fa-IR')
      .set('If-None-Match', String(first.headers.etag))
      .expect(200);
    await request(app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=fa-IR')
      .set('If-Modified-Since', String(first.headers['last-modified']))
      .expect(200);

    await app.close();
  });

  it('returns 200 for stale or malformed conditional headers and a non-matching ETag', async () => {
    const { app } = bundleApp({});
    await app.ready();

    await request(app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=fa-IR')
      .set('If-Modified-Since', 'Sun, 18 Oct 2026 10:00:00 GMT')
      .expect(200);
    await request(app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=fa-IR')
      .set('If-Modified-Since', 'not-a-date')
      .expect(200);
    await request(app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=fa-IR')
      .set('If-None-Match', 'W/"different"')
      .expect(200);

    await app.close();
  });

  it('returns cache headers on 304 and no-store on the generic 404', async () => {
    const { app } = bundleApp({});
    await app.ready();

    const first = await request(app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=en-US')
      .expect(200);
    const notModified = await request(app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=en-US')
      .set('If-None-Match', String(first.headers.etag))
      .expect(304);
    expect(notModified.headers['cache-control']).toBe('public, max-age=300');
    expect(notModified.headers.etag).toBe(first.headers.etag);
    expect(notModified.text).toBe('');

    const missing = await request(app.server)
      .get('/api/v1/clients/app-a/translations/bundle?locale=de-DE')
      .expect(404);
    expect(missing.headers['cache-control']).toBe('no-store');
    expect(missing.headers.etag).toBeUndefined();
    expect(missing.headers['content-type']).toContain('application/problem+json');

    await app.close();
  });
});
