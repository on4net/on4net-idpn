import { SocialAdapterError, type SocialProviderId } from './types.js';

/**
 * Single HTTP seam for the social adapters.
 *
 * Everything a provider call needs is explicit and injectable (`fetch`, clock-free retry delay,
 * timeouts), so adapter tests never open a socket. The rules encoded here come from
 * `docs/auth-flows.md` 9.4/9.5 and `docs/security.md`:
 *
 * - every attempt is bounded by an `AbortSignal` timeout, so a hanging provider cannot pin a
 *   request handler;
 * - retries are opt-in per request and limited to idempotent GETs that failed with a network
 *   error, timeout, `408`, `429` or `5xx`; an authorization-code exchange is never retried;
 * - provider bodies are never copied into errors, and the request URL is never included because
 *   the Facebook endpoints carry credentials in the query string.
 */

export type SocialFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface SocialHttpOptions {
  /** Injectable fetch; defaults to the runtime implementation. */
  fetch?: SocialFetch;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs?: number;
  /** Total attempts for retryable requests, including the first one. */
  maxAttempts?: number;
  /** Base backoff for retries; attempts multiply it linearly. */
  retryDelayMs?: number;
  /** Injectable delay so tests retry without waiting. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_SOCIAL_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 100;
const MAX_BODY_BYTES = 256 * 1024;

export interface SocialHttpRequest {
  provider: SocialProviderId;
  /** Short, credential-free label used in error messages, e.g. `token exchange`. */
  operation: string;
  method: 'GET' | 'POST';
  /** May contain credentials (Facebook query parameters); never logged or surfaced. */
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * Only safe, idempotent requests may retry. A code exchange is single-use, so it stays
   * `false` even though Facebook serves it over GET.
   */
  retryable: boolean;
}

/** Executes one provider call and returns the parsed JSON object. */
export async function requestSocialJson(
  options: SocialHttpOptions,
  request: SocialHttpRequest,
): Promise<Record<string, unknown>> {
  const maxAttempts = request.retryable
    ? Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchWithTimeout(options, request);
    } catch (cause) {
      if (attempt < maxAttempts) {
        await backoff(options, attempt);
        continue;
      }
      throw new SocialAdapterError(
        'provider_unavailable',
        request.provider,
        `${request.provider} ${request.operation} did not complete`,
        { retryable: true, cause },
      );
    }

    if (!response.ok) {
      const retryableStatus =
        response.status >= 500 || response.status === 408 || response.status === 429;
      if (retryableStatus && attempt < maxAttempts) {
        await backoff(options, attempt);
        continue;
      }
      throw new SocialAdapterError(
        retryableStatus ? 'provider_unavailable' : 'invalid_grant',
        request.provider,
        retryableStatus
          ? `${request.provider} ${request.operation} is temporarily unavailable`
          : `${request.provider} ${request.operation} was rejected with status ${response.status}`,
        { retryable: retryableStatus },
      );
    }

    return readJsonBody(response, request);
  }

  // Unreachable: the loop returns or throws on the final attempt.
  throw new SocialAdapterError(
    'provider_unavailable',
    request.provider,
    `${request.provider} ${request.operation} did not complete`,
    { retryable: true },
  );
}

async function fetchWithTimeout(
  options: SocialHttpOptions,
  request: SocialHttpRequest,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('social provider request timed out')),
    options.timeoutMs ?? DEFAULT_SOCIAL_TIMEOUT_MS,
  );
  try {
    const fetchImpl = options.fetch ?? fetch;
    return await fetchImpl(request.url, {
      method: request.method,
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: controller.signal,
      // A provider must not redirect a server-side credential exchange somewhere else.
      redirect: 'error',
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timeout);
  }
}

class OversizedBodyError extends Error {}

/**
 * Reads at most `limit` bytes. `response.text()` buffers the whole body first, so a provider
 * (or whatever answers in its place) could make the process hold an arbitrarily large payload
 * before the size check ran.
 */
async function readBounded(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new OversizedBodyError();
  }
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      throw new OversizedBodyError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(
  response: Response,
  request: SocialHttpRequest,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readBounded(response, MAX_BODY_BYTES);
  } catch (cause) {
    if (cause instanceof OversizedBodyError) {
      throw new SocialAdapterError(
        'invalid_response',
        request.provider,
        `${request.provider} ${request.operation} returned an oversized response`,
      );
    }
    throw new SocialAdapterError(
      'provider_unavailable',
      request.provider,
      `${request.provider} ${request.operation} response could not be read`,
      { retryable: true, cause },
    );
  }

  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new SocialAdapterError(
      'invalid_response',
      request.provider,
      `${request.provider} ${request.operation} returned an oversized response`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The SyntaxError message quotes part of the body, which may contain provider tokens, so
    // it is deliberately not chained as a cause.
    throw new SocialAdapterError(
      'invalid_response',
      request.provider,
      `${request.provider} ${request.operation} returned malformed JSON`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SocialAdapterError(
      'invalid_response',
      request.provider,
      `${request.provider} ${request.operation} returned an unexpected payload`,
    );
  }
  return parsed as Record<string, unknown>;
}

async function backoff(options: SocialHttpOptions, attempt: number): Promise<void> {
  const base = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await sleep(base * attempt);
}
