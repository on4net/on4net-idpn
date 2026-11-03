import type { JWTPayload } from 'jose';

const SCOPE_SEPARATOR = /\s+/;

/**
 * Filters the userinfo response by the scopes granted to the access token
 * (docs/api.md 2.3): `sub` always, `profile`/`email`/`phone` add their claims.
 */
export function buildUserInfo(
  claims: JWTPayload,
  profile: {
    username: string;
    email: string;
    emailVerified: boolean;
    displayName: string;
    locale: string;
    avatarUrl?: string | null;
    phone?: string | null;
    phoneVerified?: boolean;
  },
): Record<string, unknown> {
  const scopes = new Set(
    typeof claims.scope === 'string'
      ? claims.scope.split(SCOPE_SEPARATOR).filter((value) => value !== '')
      : [],
  );

  const response: Record<string, unknown> = { sub: claims.sub };

  if (scopes.has('profile')) {
    response.name = profile.displayName;
    response.preferred_username = profile.username;
    response.locale = profile.locale;
    if (profile.avatarUrl !== undefined && profile.avatarUrl !== null && profile.avatarUrl !== '') {
      response.picture = profile.avatarUrl;
    }
  }

  if (scopes.has('email')) {
    response.email = profile.email;
    response.email_verified = profile.emailVerified;
  }

  if (
    scopes.has('phone') &&
    profile.phone !== undefined &&
    profile.phone !== null &&
    profile.phone !== ''
  ) {
    response.phone_number = profile.phone;
    response.phone_number_verified = profile.phoneVerified ?? false;
  }

  return response;
}

export interface UserInfoProfileSource {
  username: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  locale: string;
  avatarUrl: string | null;
  phone: string | null;
  phoneVerified: boolean;
}
