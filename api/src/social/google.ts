import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

import { requestSocialJson, type SocialHttpOptions } from './http.js';
import {
  SocialAdapterError,
  normalizeHttpUrl,
  normalizeLocale,
  normalizeProviderUserId,
  normalizeSocialEmail,
  resolveDisplayName,
  type AuthorizationCodeExchange,
  type NormalizedSocialProfile,
  type SocialProviderAdapter,
} from './types.js';

/**
 * Google OIDC adapter (`docs/auth-flows.md` 9.4).
 *
 * The ID token is the only trusted source of identity: it is verified against Google's JWKS
 * with the per-app `client_key` as `aud`, both documented issuers, `exp` and the login nonce.
 * A missing or unverified `email` is reported as such instead of failing, so the callback flow
 * can ask the user to verify an address (`assertVerifiedEmail`).
 */

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS: readonly string[] = [
  'https://accounts.google.com',
  'accounts.google.com',
];
/** Google's documented signing algorithm for ID tokens. */
const GOOGLE_ALGORITHMS = ['RS256'];
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 30;

const googleTokenResponse = z.object({
  id_token: z.string().min(1),
});

const googleClaims = z.object({
  sub: z.string(),
  email: z.string().optional(),
  email_verified: z.unknown().optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
  locale: z.string().optional(),
});

export interface GoogleSocialAdapterOptions extends SocialHttpOptions {
  /** Overridable for tests and for an egress proxy. */
  tokenEndpoint?: string;
  jwksUri?: string;
  /** Injected JWKS resolver; the default fetches and caches Google's keys lazily. */
  keyResolver?: JWTVerifyGetKey;
  /** Tolerance for provider/IdP clock skew when checking `exp`. */
  clockToleranceSeconds?: number;
}

export class GoogleSocialAdapter implements SocialProviderAdapter {
  readonly provider = 'google' as const;

  private readonly tokenEndpoint: string;
  private readonly keyResolver: JWTVerifyGetKey;
  private readonly http: SocialHttpOptions;
  private readonly clockToleranceSeconds: number;

  constructor(options: GoogleSocialAdapterOptions = {}) {
    this.http = options;
    this.tokenEndpoint = options.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;
    this.clockToleranceSeconds = options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
    this.keyResolver =
      options.keyResolver ??
      createRemoteJWKSet(new URL(options.jwksUri ?? GOOGLE_JWKS_URI), {
        cooldownDuration: 30_000,
        cacheMaxAge: 60 * 60 * 1000,
        timeoutDuration: options.timeoutMs ?? 5_000,
      });
  }

  async exchangeAuthorizationCode(
    input: AuthorizationCodeExchange,
  ): Promise<NormalizedSocialProfile> {
    const idToken = await this.requestIdToken(input);
    const claims = await this.verifyIdToken(idToken, input);

    const providerUserId = normalizeProviderUserId(claims.sub);
    if (providerUserId === null) {
      throw new SocialAdapterError(
        'invalid_response',
        'google',
        'google ID token contains an invalid subject',
      );
    }

    const email = normalizeSocialEmail(claims.email);
    return {
      provider: 'google',
      providerUserId,
      email,
      // Only Google's boolean `true` counts; any other representation stays unverified.
      emailVerified: email !== null && claims.email_verified === true,
      displayName: resolveDisplayName(claims.name, email, providerUserId),
      avatarUrl: normalizeHttpUrl(claims.picture),
      locale: normalizeLocale(claims.locale),
    };
  }

  private async requestIdToken(input: AuthorizationCodeExchange): Promise<string> {
    const form = new URLSearchParams({
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientKey,
      client_secret: input.clientSecret,
      grant_type: 'authorization_code',
    });
    if (input.codeVerifier !== undefined) {
      form.set('code_verifier', input.codeVerifier);
    }

    const payload = await requestSocialJson(this.http, {
      provider: 'google',
      operation: 'token exchange',
      method: 'POST',
      url: this.tokenEndpoint,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
      // The authorization code is single-use, so a retry can only turn success into failure.
      retryable: false,
    });

    // A 200 response carrying `error` is not a successful exchange.
    if (typeof payload.error === 'string') {
      throw new SocialAdapterError(
        'invalid_grant',
        'google',
        'google rejected the authorization code',
      );
    }

    const parsed = googleTokenResponse.safeParse(payload);
    if (!parsed.success) {
      throw new SocialAdapterError(
        'invalid_response',
        'google',
        'google token response did not contain an ID token',
      );
    }
    return parsed.data.id_token;
  }

  private async verifyIdToken(
    idToken: string,
    input: AuthorizationCodeExchange,
  ): Promise<z.infer<typeof googleClaims>> {
    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(idToken, this.keyResolver, {
        issuer: [...GOOGLE_ISSUERS],
        audience: input.clientKey,
        algorithms: GOOGLE_ALGORITHMS,
        clockTolerance: this.clockToleranceSeconds,
      });
      payload = result.payload;
    } catch (cause) {
      // Signature, issuer, audience, expiry and algorithm failures all land here. Only the
      // stable jose error code is kept: jose errors carry the parsed claims and must not
      // travel into logs through a cause chain.
      throw new SocialAdapterError(
        'invalid_response',
        'google',
        'google ID token failed validation',
        { cause: verificationFailureCode(cause) },
      );
    }

    if (input.nonce !== undefined && payload.nonce !== input.nonce) {
      throw new SocialAdapterError('invalid_response', 'google', 'google ID token nonce mismatch');
    }

    const claims = googleClaims.safeParse(payload);
    if (!claims.success) {
      throw new SocialAdapterError(
        'invalid_response',
        'google',
        'google ID token is missing required claims',
      );
    }
    return claims.data;
  }
}

/** Maps a jose failure to its code (`ERR_JWT_EXPIRED`, ...) without copying claims or tokens. */
function verificationFailureCode(cause: unknown): Error {
  const code = (cause as { code?: unknown } | null)?.code;
  return new Error(typeof code === 'string' ? code : 'ID token verification failed');
}
