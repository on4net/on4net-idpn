import { describe, expect, it } from 'vitest';

import {
  mergeOnboardingState,
  parseClientOnboardingState,
  type ClientOnboardingState,
} from './client-onboarding.js';

const state = (overrides: Partial<ClientOnboardingState> = {}): ClientOnboardingState => ({
  version: 1,
  generatedAt: '2026-10-19T10:00:00.000Z',
  clientId: 'platform-a',
  issuer: 'https://auth.example.com',
  socialProviders: [
    {
      provider: 'google',
      existed: false,
      callbackUrl: 'https://auth.example.com/oauth2/social/platform-a/google/callback',
    },
  ],
  mapping: {
    clientId: 'platform-a',
    permissions: [{ key: 'platform-a:contact:read', created: true }],
    roles: [
      { key: 'platform-a:member', existed: false, previous: null },
      {
        key: 'platform-a:user-admin',
        existed: true,
        previous: { permissionKeys: ['idp:client-member:read'], isDefault: false },
      },
    ],
  },
  ...overrides,
});

describe('onboarding state', () => {
  it('keeps the first observation when an app is applied twice', () => {
    const first = state();
    const second = state({
      generatedAt: '2026-10-19T11:00:00.000Z',
      socialProviders: [
        {
          provider: 'google',
          existed: true,
          callbackUrl: first.socialProviders[0]!.callbackUrl,
        },
        {
          provider: 'facebook',
          existed: false,
          callbackUrl: 'https://auth.example.com/oauth2/social/platform-a/facebook/callback',
        },
      ],
      mapping: {
        clientId: 'platform-a',
        permissions: [{ key: 'platform-a:contact:read', created: false }],
        roles: [
          {
            key: 'platform-a:member',
            existed: true,
            previous: { permissionKeys: [], isDefault: true },
          },
        ],
      },
    });

    const merged = mergeOnboardingState(first, second);
    expect(merged.socialProviders.map((entry) => [entry.provider, entry.existed])).toEqual([
      ['google', false],
      ['facebook', false],
    ]);
    expect(merged.mapping.permissions).toEqual([{ key: 'platform-a:contact:read', created: true }]);
    expect(merged.mapping.roles).toEqual([
      { key: 'platform-a:member', existed: false, previous: null },
      {
        key: 'platform-a:user-admin',
        existed: true,
        previous: { permissionKeys: ['idp:client-member:read'], isDefault: false },
      },
    ]);
    expect(merged.generatedAt).toBe('2026-10-19T11:00:00.000Z');
  });

  it('starts from the new state when the client or file differs', () => {
    const merged = mergeOnboardingState(null, state());
    expect(merged.socialProviders[0]?.existed).toBe(false);
    const otherClient = mergeOnboardingState(state(), state({ clientId: 'platform-b' }));
    expect(otherClient.clientId).toBe('platform-b');
  });

  it('rejects a tampered state file before a rollback', () => {
    expect(parseClientOnboardingState({ version: 2 }).ok).toBe(false);
    const parsed = parseClientOnboardingState(state());
    expect(parsed.ok).toBe(true);
    expect(parsed.state?.mapping.roles).toHaveLength(2);
  });
});
