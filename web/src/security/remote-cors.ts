import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Plugin } from 'vite';

import { decideCors } from './headers.js';

type Next = (error?: unknown) => void;

/**
 * Origin allowlist for the Module Federation remote dev/preview server.
 *
 * Replaces `cors: true` and `Access-Control-Allow-Origin: *`: a host that is not listed gets
 * a 403 on both the preflight and the module request, so a leaked remote URL cannot be
 * embedded by an arbitrary origin (docs/micro-frontend.md 12).
 */
export function remoteCorsPlugin(allowedOrigins: readonly string[]): Plugin {
  const middleware = (request: IncomingMessage, response: ServerResponse, next: Next): void => {
    const decision = decideCors(request.headers.origin, allowedOrigins);
    for (const [name, value] of Object.entries(decision.headers)) {
      response.setHeader(name, value);
    }
    if (!decision.allowed) {
      response.statusCode = 403;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('origin not allowed');
      return;
    }
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    next();
  };

  return {
    name: 'idpn-remote-cors',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

/** Parses a comma-separated origin list, ignoring malformed entries. */
export function parseOrigins(value: string | undefined, fallback: readonly string[]): string[] {
  if (value === undefined || value.trim() === '') {
    return [...fallback];
  }
  const origins: string[] = [];
  for (const entry of value.split(',')) {
    const candidate = entry.trim();
    if (candidate === '') {
      continue;
    }
    try {
      const url = new URL(candidate);
      if (url.origin === candidate) {
        origins.push(candidate);
      }
    } catch {
      // Ignore malformed entries: an invalid origin must never become a wildcard.
    }
  }
  return origins.length === 0 ? [...fallback] : origins;
}
