import { describe, expect, it } from 'vitest';

import {
  adapterErrorToSocialError,
  emailDomainAllowed,
  registrationAllowed,
  userCanSignIn,
} from './account-linking.js';

describe('registration policy', () => {
  const base = {
    clientEmailDomains: ['example.com'],
    providerEmailDomains: ['partner.example'],
    email: 'sara@example.com',
  };

  it('allows self-service regardless of the allowlist', () => {
    expect(
      registrationAllowed({ ...base, registrationPolicy: 'self_service', email: 'a@other.test' }),
    ).toBe(true);
  });

  it('never allows registration when the client disabled it', () => {
    expect(
      registrationAllowed({ ...base, registrationPolicy: 'disabled', email: 'sara@example.com' }),
    ).toBe(false);
  });

  it('admits an allowlisted domain under invite_only', () => {
    expect(registrationAllowed({ ...base, registrationPolicy: 'invite_only' })).toBe(true);
    expect(
      registrationAllowed({
        ...base,
        registrationPolicy: 'invite_only',
        email: 'sara@partner.example',
      }),
    ).toBe(true);
    expect(
      registrationAllowed({
        ...base,
        registrationPolicy: 'invite_only',
        email: 'sara@unlisted.test',
      }),
    ).toBe(false);
    expect(registrationAllowed({ ...base, registrationPolicy: 'invite_only', email: null })).toBe(
      false,
    );
  });

  it('matches domains case-insensitively and tolerates a leading @', () => {
    expect(emailDomainAllowed('Sara@Example.COM', ['example.com'])).toBe(true);
    expect(emailDomainAllowed('sara@example.com', ['@Example.com'])).toBe(true);
    expect(emailDomainAllowed('sara@sub.example.com', ['example.com'])).toBe(false);
    expect(emailDomainAllowed('sara@example.com', [''])).toBe(false);
    expect(emailDomainAllowed('example.com', ['example.com'])).toBe(false);
  });
});

describe('account state', () => {
  it('only lets active, non-deleted users sign in', () => {
    expect(userCanSignIn({ status: 'active', deletedAt: null })).toBe(true);
    expect(userCanSignIn({ status: 'locked', deletedAt: null })).toBe(false);
    expect(userCanSignIn({ status: 'disabled', deletedAt: null })).toBe(false);
    expect(userCanSignIn({ status: 'pending', deletedAt: null })).toBe(false);
    expect(userCanSignIn({ status: 'active', deletedAt: new Date() })).toBe(false);
  });

  it('maps every adapter error to a public social error code', () => {
    expect(adapterErrorToSocialError('email_unverified')).toBe('social_email_unverified');
    expect(adapterErrorToSocialError('invalid_grant')).toBe('social_provider_error');
    expect(adapterErrorToSocialError('provider_unavailable')).toBe('social_provider_error');
    expect(adapterErrorToSocialError('invalid_response')).toBe('social_provider_error');
  });
});
