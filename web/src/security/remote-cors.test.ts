import { describe, expect, it, vi } from 'vitest';

import { remoteCorsPlugin } from './remote-cors';

interface TestResponse {
  statusCode: number;
  headers: Record<string, string>;
  body?: string;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

type Middleware = (
  request: { method?: string; headers: { origin?: string } },
  response: TestResponse,
  next: (error?: unknown) => void,
) => void;

const createResponse = (): TestResponse => ({
  statusCode: 200,
  headers: {},
  setHeader(name, value) {
    this.headers[name] = value;
  },
  end(body) {
    if (body !== undefined) {
      this.body = body;
    }
  },
});

const install = (hook: unknown): Middleware[] => {
  const middlewares: Middleware[] = [];
  const server = {
    middlewares: {
      use: (middleware: Middleware) => {
        middlewares.push(middleware);
      },
    },
  };
  if (typeof hook === 'function') {
    (hook as (value: unknown) => void)(server);
  } else if (hook !== null && typeof hook === 'object' && 'handler' in hook) {
    (hook as { handler: (value: unknown) => void }).handler(server);
  }
  return middlewares;
};

describe('remote CORS plugin', () => {
  const allowed = ['https://app.example.com'];

  it('installs the allowlist on both the dev and preview servers', () => {
    const plugin = remoteCorsPlugin(allowed);

    expect(install(plugin.configureServer)).toHaveLength(1);
    expect(install(plugin.configurePreviewServer)).toHaveLength(1);
  });

  it('echoes an allowed origin and calls the next middleware', () => {
    const middleware = install(remoteCorsPlugin(allowed).configureServer)[0];
    if (middleware === undefined) {
      throw new Error('middleware not installed');
    }
    const next = vi.fn();
    const response = createResponse();

    middleware({ method: 'GET', headers: { origin: 'https://app.example.com' } }, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    expect(response.headers.Vary).toBe('Origin');
  });

  it('rejects an unknown origin before the module is served', () => {
    const middleware = install(remoteCorsPlugin(allowed).configureServer)[0];
    if (middleware === undefined) {
      throw new Error('middleware not installed');
    }
    const next = vi.fn();
    const response = createResponse();

    middleware({ method: 'GET', headers: { origin: 'https://evil.example.com' } }, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(403);
    expect(response.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('answers a preflight without touching the static file server', () => {
    const middleware = install(remoteCorsPlugin(allowed).configureServer)[0];
    if (middleware === undefined) {
      throw new Error('middleware not installed');
    }
    const next = vi.fn();
    const response = createResponse();

    middleware(
      { method: 'OPTIONS', headers: { origin: 'https://app.example.com' } },
      response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(204);
    expect(response.headers['Access-Control-Allow-Methods']).toContain('GET');
  });
});
