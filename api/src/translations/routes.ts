import { createHash } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { matchLocale } from '@idpn/i18n/locale';

import { buildTranslationBundle } from './bundle.js';
import { BUNDLE_CACHE_TTL_SECONDS, bundleCacheKey, type BundleCache } from './cache.js';
import type { PublicTranslationRepository } from './prisma-repository.js';

export interface TranslationBundleRouteOptions {
  repository: PublicTranslationRepository;
  cache?: BundleCache;
  /** Optional CORS allowlist, matching the public-config endpoint's behavior. */
  allowedOrigins?: (clientId: string) => Promise<string[]>;
  maxAgeSeconds?: number;
  now?: () => number;
}

/**
 * `GET /api/v1/clients/{clientId}/translations/bundle?locale=` (docs/api.md 3.3.4,
 * docs/localization.md 6.2).
 *
 * - base bundle + per-client overrides, never any secret or unrelated client data;
 * - unknown/disabled clients and unsupported locales share one generic `404`;
 * - `ETag`, `Last-Modified`, `Cache-Control: public, max-age=300` and conditional `304`;
 * - Redis caches the serialized body and the admin write path deletes the keys.
 */
export function registerTranslationBundleRoute(
  app: FastifyInstance,
  options: TranslationBundleRouteOptions,
): void {
  const maxAge = options.maxAgeSeconds ?? BUNDLE_CACHE_TTL_SECONDS;
  const nowMs = options.now ?? (() => Date.now());

  app.get<{ Params: { clientId: string }; Querystring: { locale?: string } }>(
    '/api/v1/clients/:clientId/translations/bundle',
    async (request, reply) => {
      const { clientId } = request.params;
      const client = await options.repository.findClient(clientId);
      if (client === null || client.status !== 'active') {
        return notFound(reply);
      }

      const requested = request.query.locale;
      if (requested !== undefined && typeof requested !== 'string') {
        return notFound(reply);
      }
      const locale =
        requested === undefined || requested.trim() === ''
          ? client.settings.default
          : matchLocale(requested, client.settings.supported);
      if (locale === undefined) {
        return notFound(reply);
      }

      const key = bundleCacheKey(client.clientId, locale);
      let body = options.cache === undefined ? null : await options.cache.get(key);
      if (body === null) {
        const overrides = await options.repository.findOverrides(client.clientId, locale);
        const bundle = buildTranslationBundle({
          locale,
          settings: client.settings,
          overrides,
        });
        if (bundle === null) {
          return notFound(reply);
        }
        body = JSON.stringify(bundle);
        if (options.cache !== undefined) {
          await options.cache.set(key, body, maxAge);
        }
      }

      const etag = etagFor(body);
      const lastModified = lastModifiedFor(body, nowMs());
      await applyCors(request, reply, options, client.clientId);

      const cacheHeaders = {
        ETag: etag,
        'Cache-Control': `public, max-age=${maxAge}`,
        'Last-Modified': lastModified.toUTCString(),
      };

      if (matchesEtag(request.headers['if-none-match'], etag)) {
        return reply.code(304).headers(cacheHeaders).send();
      }
      const ifModifiedSince = request.headers['if-modified-since'];
      if (
        typeof ifModifiedSince === 'string' &&
        !Number.isNaN(Date.parse(ifModifiedSince)) &&
        lastModified.getTime() <= Date.parse(ifModifiedSince)
      ) {
        return reply.code(304).headers(cacheHeaders).send();
      }

      return reply
        .headers(cacheHeaders)
        .header('Content-Type', 'application/json; charset=utf-8')
        .send(body);
    },
  );
}

function etagFor(body: string): string {
  return `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 32)}"`;
}

function lastModifiedFor(body: string, fallbackMs: number): Date {
  try {
    const parsed = JSON.parse(body) as { version?: unknown };
    if (typeof parsed.version === 'string') {
      const date = new Date(parsed.version);
      if (!Number.isNaN(date.getTime())) {
        return new Date(Math.floor(date.getTime() / 1000) * 1000);
      }
    }
  } catch {
    // Fall through to the injected clock.
  }
  return new Date(Math.floor(fallbackMs / 1000) * 1000);
}

function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (value === undefined) {
    return false;
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .some((entry) => entry === '*' || entry === etag);
}

async function applyCors(
  request: FastifyRequest,
  reply: FastifyReply,
  options: TranslationBundleRouteOptions,
  clientId: string,
): Promise<void> {
  if (options.allowedOrigins === undefined) {
    return;
  }
  const origin = request.headers.origin;
  if (origin === undefined) {
    return;
  }
  const allowed = await options.allowedOrigins(clientId);
  if (allowed.includes(origin)) {
    reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
  }
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply
    .code(404)
    .header('Content-Type', 'application/problem+json')
    .header('Cache-Control', 'no-store')
    .send({ type: 'about:blank', title: 'Translations not found', status: 404 });
}
