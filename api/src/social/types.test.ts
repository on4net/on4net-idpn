import { describe, expect, it } from 'vitest';

import { SOCIAL_PROVIDERS } from '../admin/social-providers/social-provider-types.js';
import { FacebookSocialAdapter } from './facebook.js';
import { GoogleSocialAdapter } from './google.js';
import {
  SocialAdapterError,
  assertVerifiedEmail,
  normalizeHttpUrl,
  normalizeLocale,
  normalizeProviderUserId,
  normalizeSocialEmail,
  resolveDisplayName,
  type NormalizedSocialProfile,
  type SocialProviderAdapter,
} from './types.js';

const profile: NormalizedSocialProfile = {
  provider: 'google',
  providerUserId: 'google-user-1',
  email: 'ada@example.com',
  emailVerified: true,
  displayName: 'Ada Lovelace',
  avatarUrl: null,
  locale: null,
};

describe('social profile normalization', () => {
  it('keeps well-formed emails and trims surrounding whitespace', () => {
    expect(normalizeSocialEmail('  ada@example.com ')).toBe('ada@example.com');
  });

  it.each([
    '',
    'no-at-sign',
    '@example.com',
    'ada@',
    'a@b@c',
    'ada lovelace@example.com',
    42,
    null,
  ])('drops a malformed email: %s', (value) => {
    expect(normalizeSocialEmail(value)).toBeNull();
  });

  it('drops an over-long email', () => {
    expect(normalizeSocialEmail(`${'a'.repeat(320)}@example.com`)).toBeNull();
  });

  it('accepts structural locale tags and rejects free text', () => {
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('fa-IR')).toBe('fa-IR');
    expect(normalizeLocale('not a locale')).toBeNull();
    expect(normalizeLocale('x'.repeat(40))).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
  });

  it('only keeps absolute http(s) avatar URLs', () => {
    expect(normalizeHttpUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(normalizeHttpUrl('http://cdn.example.com/a.png')).toBe('http://cdn.example.com/a.png');
    expect(normalizeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeHttpUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(normalizeHttpUrl('/relative.png')).toBeNull();
    expect(normalizeHttpUrl('https://')).toBeNull();
    expect(normalizeHttpUrl(false)).toBeNull();
  });

  it('validates provider user ids', () => {
    expect(normalizeProviderUserId(' google-user-1 ')).toBe('google-user-1');
    expect(normalizeProviderUserId('')).toBeNull();
    expect(normalizeProviderUserId('has space')).toBeNull();
    expect(normalizeProviderUserId('x'.repeat(256))).toBeNull();
    expect(normalizeProviderUserId(7)).toBeNull();
  });

  it('resolves a display name with deterministic fallbacks', () => {
    expect(resolveDisplayName('  Ada   Lovelace ', 'ada@example.com', 'id')).toBe('Ada Lovelace');
    expect(resolveDisplayName('', 'ada@example.com', 'id')).toBe('ada');
    expect(resolveDisplayName(undefined, null, 'provider-id')).toBe('provider-id');
    expect(resolveDisplayName('x'.repeat(500), null, 'id')).toHaveLength(200);
  });
});

describe('assertVerifiedEmail', () => {
  it('narrows a verified profile', () => {
    expect(assertVerifiedEmail(profile).email).toBe('ada@example.com');
  });

  it('rejects an unverified email', () => {
    const error = (() => {
      try {
        assertVerifiedEmail({ ...profile, emailVerified: false });
      } catch (caught) {
        return caught;
      }
      throw new Error('expected assertVerifiedEmail to throw');
    })();

    expect(error).toBeInstanceOf(SocialAdapterError);
    expect((error as SocialAdapterError).code).toBe('email_unverified');
    expect((error as SocialAdapterError).retryable).toBe(false);
  });

  it('rejects a missing email', () => {
    expect(() => assertVerifiedEmail({ ...profile, email: null })).toThrow(
      /did not return an email/,
    );
  });
});

describe('SocialAdapterError', () => {
  it('defaults to non-retryable and preserves the cause', () => {
    const cause = new Error('socket closed');
    const error = new SocialAdapterError('provider_unavailable', 'facebook', 'boom', { cause });

    expect(error.name).toBe('SocialAdapterError');
    expect(error.retryable).toBe(false);
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('boom');
  });
});

describe('adapter coverage', () => {
  it('implements exactly the persisted provider enum', () => {
    const adapters: SocialProviderAdapter[] = [
      new GoogleSocialAdapter(),
      new FacebookSocialAdapter(),
    ];

    expect(adapters.map((adapter) => adapter.provider).sort()).toEqual(
      [...SOCIAL_PROVIDERS].sort(),
    );
  });
});
