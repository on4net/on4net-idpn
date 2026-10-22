import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';

import type { SocialFetch } from '../src/social/http.js';

/**
 * Deterministic fixtures for the social adapter tests: a locally generated RS256 key set and an
 * injectable fetch that records requests. No test in this suite opens a socket or uses a real
 * provider credential (`docs/testing.md`).
 */

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  abortSignal: AbortSignal | null;
}

export type FetchHandler = (request: RecordedRequest) => Response | Promise<Response>;

export interface FakeFetch {
  fetch: SocialFetch;
  requests: RecordedRequest[];
}

/** Serves the handlers in order and fails loudly on an unexpected extra request. */
export function fakeFetch(...handlers: FetchHandler[]): FakeFetch {
  const requests: RecordedRequest[] = [];
  let next = 0;

  const fetchImpl: SocialFetch = async (input, init) => {
    const handler = handlers[next];
    if (handler === undefined) {
      throw new Error(`unexpected social request #${next + 1}`);
    }
    next += 1;

    const request: RecordedRequest = {
      url: new URL(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : null,
      abortSignal: init?.signal ?? null,
    };
    requests.push(request);
    return handler(request);
  };

  return { fetch: fetchImpl, requests };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Returns a body that is not JSON at all, mimicking an HTML error page behind a proxy. */
export function malformedResponse(status = 200): Response {
  return new Response('<html>not json</html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

/** Never resolves until the adapter's timeout aborts the signal. */
export const hangingFetch: SocialFetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === null || signal === undefined) {
      return;
    }
    const fail = (): void => reject(signal.reason);
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });

export interface IdTokenSigner {
  keyResolver: JWTVerifyGetKey;
  sign(claims: Record<string, unknown>): Promise<string>;
}

/** Builds a fresh RSA key pair; each call returns an independent issuer for signature tests. */
export async function createIdTokenSigner(kid = 'test-key'): Promise<IdTokenSigner> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };

  return {
    keyResolver: createLocalJWKSet({ keys: [jwk] }),
    sign: (claims) =>
      new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid }).sign(privateKey),
  };
}

/** Unix seconds helper so expiry tests derive from the real clock. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
