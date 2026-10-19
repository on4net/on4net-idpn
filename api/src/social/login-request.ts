import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

import type { SocialProviderId } from './types.js';

/**
 * Server-side login transactions for the per-app social flow (`docs/auth-flows.md` 9,
 * `docs/api.md` 2.8).
 *
 * Two records exist:
 *
 * 1. **authorize login request** — created by `/oauth2/authorize` before the user is sent to
 *    the Hosted UI. It binds the validated authorize request (as an absolute URL) to one
 *    `client_id`, so the social start endpoint never has to trust browser-supplied parameters.
 * 2. **social login request** — created by `.../start`, holding the `state`, optional `nonce`,
 *    PKCE verifier/challenge, the exact callback URI and the authorize URL to return to.
 *
 * Every value is server-generated; the browser only ever carries opaque handles (`login_request`
 * and `state`). Both records are single-use and short-lived (see `transaction-store.ts`).
 */

/** Enough entropy that guessing a state or login_request is infeasible. */
const STATE_BYTES = 32;
/** PKCE verifiers must be 43–128 characters; 32 random bytes encode to 43 base64url chars. */
const CODE_VERIFIER_BYTES = 32;
const NONCE_BYTES = 32;

export const AUTHORIZE_LOGIN_REQUEST_TTL_SECONDS = 10 * 60;
export const SOCIAL_LOGIN_REQUEST_TTL_SECONDS = 10 * 60;

const providerSchema = z.enum(['google', 'facebook']);

/** Record handed from `/oauth2/authorize` to the Hosted UI and then to `.../start`. */
export interface AuthorizeLoginTransaction {
  clientId: string;
  /** Absolute `/oauth2/authorize` URL; the callback redirects here after a successful login. */
  authorizeUrl: string;
  createdAt: string;
}

/** Record created by `.../start` and consumed by `.../callback`. */
export interface SocialLoginTransaction {
  state: string;
  clientId: string;
  provider: SocialProviderId;
  /** Byte-exact callback URI registered at the provider. */
  redirectUri: string;
  /** Authorize URL stored on the server, never taken from the callback query. */
  returnTo: string;
  /** Google only; `null` for providers without an ID-token nonce. */
  nonce: string | null;
  codeVerifier: string;
  codeChallenge: string;
  createdAt: string;
}

const createdAtSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO-8601 timestamp');

/**
 * Parsed before a stored record is used. A corrupted or partially written cache entry must be
 * treated exactly like an expired one, never as a partially valid transaction.
 */
export const authorizeLoginTransactionSchema = z.object({
  clientId: z.string().min(1).max(64),
  authorizeUrl: z.string().url(),
  createdAt: createdAtSchema,
});

export const socialLoginTransactionSchema = z.object({
  state: z.string().min(43).max(128),
  clientId: z.string().min(1).max(64),
  provider: providerSchema,
  redirectUri: z.string().url(),
  returnTo: z.string().url(),
  nonce: z.string().min(1).max(128).nullable(),
  codeVerifier: z.string().min(43).max(128),
  codeChallenge: z.string().min(1).max(128),
  createdAt: createdAtSchema,
});

/** 256-bit base64url value; unguessable and URL-safe. */
export function randomToken(byteLength: number): string {
  return randomBytes(byteLength).toString('base64url');
}

export function createState(): string {
  return randomToken(STATE_BYTES);
}

export function createNonce(): string {
  return randomToken(NONCE_BYTES);
}

export function createCodeVerifier(): string {
  return randomToken(CODE_VERIFIER_BYTES);
}

/** S256 challenge (`RFC 7636`): base64url(SHA-256(verifier)). */
export function codeChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export interface CreateSocialLoginTransactionInput {
  clientId: string;
  provider: SocialProviderId;
  redirectUri: string;
  returnTo: string;
  now?: Date;
}

/** Builds a complete social login transaction; nothing here is taken from the browser. */
export function createSocialLoginTransaction(
  input: CreateSocialLoginTransactionInput,
): SocialLoginTransaction {
  const codeVerifier = createCodeVerifier();
  return {
    state: createState(),
    clientId: input.clientId,
    provider: input.provider,
    redirectUri: input.redirectUri,
    returnTo: input.returnTo,
    // Google signs the nonce into its ID token, so the adapter can bind the response to this
    // attempt. Facebook has no equivalent claim.
    nonce: input.provider === 'google' ? createNonce() : null,
    codeVerifier,
    codeChallenge: codeChallengeFor(codeVerifier),
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

/**
 * A callback may only continue a transaction started for the same client and provider
 * (acceptance: cross-client callback rejected).
 */
export function transactionMatches(
  transaction: Pick<SocialLoginTransaction, 'clientId' | 'provider'>,
  clientId: string,
  provider: SocialProviderId,
): boolean {
  return transaction.clientId === clientId && transaction.provider === provider;
}

/** Only the issuer's own `/oauth2/authorize` may be used as a post-login destination. */
export function isSameOriginAuthorizeUrl(value: string, issuer: string): boolean {
  try {
    const candidate = new URL(value);
    return (
      candidate.origin === new URL(issuer).origin && candidate.pathname === '/oauth2/authorize'
    );
  } catch {
    return false;
  }
}
