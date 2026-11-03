import { z } from 'zod';

import { requestSocialJson, type SocialHttpOptions } from './http.js';
import {
  SocialAdapterError,
  normalizeHttpUrl,
  normalizeProviderUserId,
  normalizeSocialEmail,
  resolveDisplayName,
  type AuthorizationCodeExchange,
  type NormalizedSocialProfile,
  type SocialProviderAdapter,
} from './types.js';

/**
 * Facebook OAuth2 / Graph adapter (`docs/auth-flows.md` 9.4).
 *
 * Identity is taken from the Graph API only; nothing the browser sends is trusted. The exchange
 * is followed by a `debug_token` check, because a token minted for a different app must never
 * produce an identity here:
 *
 * - `is_valid` must be `true`;
 * - `app_id` must equal this app's `client_key`;
 * - `user_id`, when present, must equal the profile `id`.
 *
 * **Verified-email rule:** Facebook exposes no `email` verification claim, so every Facebook
 * profile is normalized with `emailVerified: false`. `docs/auth-flows.md` 9.3 forbids auto-linking
 * on an unverified address, therefore the callback flow must not link (or create) by email until
 * the address is verified through the IdP (`assertVerifiedEmail`). The address itself is kept
 * when Facebook returns one, so the user can complete that verification.
 */

export const FACEBOOK_GRAPH_BASE_URL = 'https://graph.facebook.com/v21.0';
const PROFILE_FIELDS = 'id,name,email,picture.type(large)';

const facebookTokenResponse = z.object({
  access_token: z.string().min(1),
});

const facebookDebugTokenResponse = z.object({
  data: z.object({
    is_valid: z.boolean(),
    app_id: z.union([z.string(), z.number()]).optional(),
    user_id: z.union([z.string(), z.number()]).optional(),
  }),
});

const facebookProfileResponse = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string().optional(),
  email: z.string().optional(),
  picture: z
    .union([z.object({ data: z.object({ url: z.string().optional() }).optional() }), z.string()])
    .optional(),
});

export interface FacebookSocialAdapterOptions extends SocialHttpOptions {
  /** Versioned Graph base; bump deliberately when the pinned version is retired. */
  graphBaseUrl?: string;
}

interface FacebookAccessToken {
  accessToken: string;
  userId: string | null;
}

export class FacebookSocialAdapter implements SocialProviderAdapter {
  readonly provider = 'facebook' as const;

  private readonly graphBaseUrl: string;
  private readonly http: SocialHttpOptions;

  constructor(options: FacebookSocialAdapterOptions = {}) {
    this.http = options;
    this.graphBaseUrl = (options.graphBaseUrl ?? FACEBOOK_GRAPH_BASE_URL).replace(/\/+$/, '');
  }

  async exchangeAuthorizationCode(
    input: AuthorizationCodeExchange,
  ): Promise<NormalizedSocialProfile> {
    const token = await this.requestAccessToken(input);
    const profile = await this.requestProfile(token.accessToken);

    const providerUserId = normalizeProviderUserId(String(profile.id));
    if (providerUserId === null) {
      throw new SocialAdapterError(
        'invalid_response',
        'facebook',
        'facebook profile contains an invalid user id',
      );
    }
    if (token.userId !== null && token.userId !== providerUserId) {
      throw new SocialAdapterError(
        'invalid_response',
        'facebook',
        'facebook access token does not belong to this profile',
      );
    }

    const email = normalizeSocialEmail(profile.email);
    return {
      provider: 'facebook',
      providerUserId,
      email,
      // Facebook returns no verification signal; never treat its email as verified.
      emailVerified: false,
      displayName: resolveDisplayName(profile.name, email, providerUserId),
      avatarUrl: readAvatarUrl(profile.picture),
      locale: null,
    };
  }

  private async requestAccessToken(input: AuthorizationCodeExchange): Promise<FacebookAccessToken> {
    const url = new URL(`${this.graphBaseUrl}/oauth/access_token`);
    url.searchParams.set('client_id', input.clientKey);
    url.searchParams.set('client_secret', input.clientSecret);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('code', input.code);
    if (input.codeVerifier !== undefined) {
      url.searchParams.set('code_verifier', input.codeVerifier);
    }

    const payload = await requestSocialJson(this.http, {
      provider: 'facebook',
      operation: 'token exchange',
      method: 'GET',
      // The URL carries the code and secret; it is handed to fetch only and never logged.
      url: url.toString(),
      headers: { accept: 'application/json' },
      // The authorization code is single-use, so this GET must not retry.
      retryable: false,
    });

    if (payload.error !== undefined) {
      throw new SocialAdapterError(
        'invalid_grant',
        'facebook',
        'facebook rejected the authorization code',
      );
    }

    const parsed = facebookTokenResponse.safeParse(payload);
    if (!parsed.success) {
      throw new SocialAdapterError(
        'invalid_response',
        'facebook',
        'facebook token response did not contain an access token',
      );
    }

    return this.verifyAccessToken(parsed.data.access_token, input);
  }

  /** Confirms the token was issued to this app (`docs/auth-flows.md` 9.4). */
  private async verifyAccessToken(
    accessToken: string,
    input: AuthorizationCodeExchange,
  ): Promise<FacebookAccessToken> {
    const url = new URL(`${this.graphBaseUrl}/debug_token`);
    url.searchParams.set('input_token', accessToken);
    url.searchParams.set('access_token', `${input.clientKey}|${input.clientSecret}`);

    const payload = await requestSocialJson(this.http, {
      provider: 'facebook',
      operation: 'token inspection',
      method: 'GET',
      url: url.toString(),
      headers: { accept: 'application/json' },
      // Read-only, so a transient network/5xx failure is safe to retry.
      retryable: true,
    });

    const parsed = facebookDebugTokenResponse.safeParse(payload);
    if (!parsed.success) {
      throw new SocialAdapterError(
        'invalid_response',
        'facebook',
        'facebook token inspection returned an unexpected payload',
      );
    }

    const data = parsed.data.data;
    if (!data.is_valid) {
      throw new SocialAdapterError(
        'invalid_grant',
        'facebook',
        'facebook access token is not valid',
      );
    }
    if (data.app_id === undefined || String(data.app_id) !== input.clientKey) {
      throw new SocialAdapterError(
        'invalid_response',
        'facebook',
        'facebook access token was issued to another app',
      );
    }

    return {
      accessToken,
      userId: data.user_id === undefined ? null : String(data.user_id),
    };
  }

  private async requestProfile(accessToken: string) {
    const url = new URL(`${this.graphBaseUrl}/me`);
    url.searchParams.set('fields', PROFILE_FIELDS);

    const payload = await requestSocialJson(this.http, {
      provider: 'facebook',
      operation: 'profile lookup',
      method: 'GET',
      url: url.toString(),
      headers: {
        accept: 'application/json',
        // The user token travels in a header, so it stays out of the URL.
        authorization: `Bearer ${accessToken}`,
      },
      retryable: true,
    });

    const parsed = facebookProfileResponse.safeParse(payload);
    if (!parsed.success) {
      throw new SocialAdapterError(
        'invalid_response',
        'facebook',
        'facebook profile returned an unexpected payload',
      );
    }
    return parsed.data;
  }
}

function readAvatarUrl(picture: z.infer<typeof facebookProfileResponse>['picture']): string | null {
  if (typeof picture === 'string') {
    return normalizeHttpUrl(picture);
  }
  return picture?.data?.url === undefined ? null : normalizeHttpUrl(picture.data.url);
}
