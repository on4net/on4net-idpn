import type { PublicClientConfig } from '@idpn/contracts';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { buildPublicClientConfig, type PublicClientSource } from './build.js';

export interface PublicConfigRouteOptions {
  repository: { findPublicClient(clientId: string): Promise<PublicClientSource | null> };
  /** Origins allowed to mount the MFE; a request from another origin gets no CORS header. */
  allowedOrigins: (clientId: string) => Promise<string[]>;
  dependencies: {
    mfe: { version: string; remoteEntry: string };
    /** Template with `{clientId}`; resolved per request. */
    translationsUrlTemplate?: string;
  };
  /** Requests per window per IP + client (enumeration protection). */
  rateLimit?: { windowSeconds: number; max: number };
  now?: () => number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * `GET /api/v1/clients/{clientId}/public-config` (docs/api.md 2.7).
 *
 * - only active clients are served, unknown/disabled get the same 404 (no enumeration);
 * - CORS is answered only for the client's allowed origins;
 * - `ETag` + `Cache-Control: public, max-age=60` enable conditional requests;
 * - a per-IP, per-client fixed window returns 429 with `Retry-After`.
 */
export function registerPublicConfigRoute(
  app: FastifyInstance,
  options: PublicConfigRouteOptions,
): void {
  const buckets = new Map<string, Bucket>();
  const limit = options.rateLimit ?? { windowSeconds: 60, max: 60 };
  const nowMs = options.now ?? (() => Date.now());

  app.get('/api/v1/clients/:clientId/public-config', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const ip = request.ip;
    const bucketKey = `${ip}:${clientId}`;
    if (!consume(buckets, bucketKey, limit, nowMs())) {
      return problem(reply, 429, 'Too many requests', {
        'Retry-After': String(limit.windowSeconds),
      });
    }

    const client = await options.repository.findPublicClient(clientId);
    if (client === null) {
      // Same response for unknown and disabled clients.
      return problem(reply, 404, 'Client configuration not found');
    }

    const config = buildPublicClientConfig(client, {
      mfe: options.dependencies.mfe,
      ...(options.dependencies.translationsUrlTemplate === undefined
        ? {}
        : {
            translationsUrl: options.dependencies.translationsUrlTemplate.replace(
              '{clientId}',
              encodeURIComponent(client.clientId),
            ),
          }),
    });
    const body = JSON.stringify(config);
    const etag = `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 32)}"`;

    applyCors(request, reply, await options.allowedOrigins(client.clientId));

    if (request.headers['if-none-match'] === etag) {
      return reply
        .code(304)
        .header('ETag', etag)
        .header('Cache-Control', 'public, max-age=60')
        .send();
    }

    return reply
      .header('ETag', etag)
      .header('Cache-Control', 'public, max-age=60')
      .header('Content-Type', 'application/json; charset=utf-8')
      .send(body);
  });
}

function consume(
  buckets: Map<string, Bucket>,
  key: string,
  limit: { windowSeconds: number; max: number },
  now: number,
): boolean {
  const bucket = buckets.get(key);
  if (bucket === undefined || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + limit.windowSeconds * 1000 });
    return true;
  }
  if (bucket.count >= limit.max) {
    return false;
  }
  bucket.count += 1;
  return true;
}

function applyCors(request: FastifyRequest, reply: FastifyReply, allowed: string[]): void {
  const origin = request.headers.origin;
  if (origin !== undefined && allowed.includes(origin)) {
    reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
  }
}

function problem(
  reply: FastifyReply,
  status: number,
  title: string,
  headers: Record<string, string> = {},
): FastifyReply {
  let target = reply
    .code(status)
    .header('Content-Type', 'application/problem+json')
    .header('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(headers)) {
    target = target.header(name, value);
  }
  return target.send({ type: 'about:blank', title, status });
}

export type { PublicClientConfig };
