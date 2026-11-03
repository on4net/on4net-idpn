import { describe, expect, it } from 'vitest';

import {
  callbackUrlProblem,
  combineCredentialLookups,
  createEnvCredentialLookup,
  maskClientKey,
  parseSecretsFile,
  productionConfirmationProblem,
  resolveCallbackBase,
  socialCredentialEnvRef,
} from './social-credentials.js';

const googleKey = 'fake-client-id.apps.googleusercontent.com';
const googleSecret = 'fake-not-a-real-secret';

describe('credential references', () => {
  it('derives deterministic environment variable names', () => {
    expect(socialCredentialEnvRef('platform-a', 'google', 'CLIENT_KEY')).toBe(
      'IDPN_SOCIAL_PLATFORM_A_GOOGLE_CLIENT_KEY',
    );
    expect(socialCredentialEnvRef('platform.b', 'facebook', 'CLIENT_SECRET')).toBe(
      'IDPN_SOCIAL_PLATFORM_B_FACEBOOK_CLIENT_SECRET',
    );
  });

  it('reads credentials from the environment and honours an explicit ref', () => {
    const env = {
      IDPN_SOCIAL_PLATFORM_A_GOOGLE_CLIENT_KEY: googleKey,
      IDPN_SOCIAL_PLATFORM_A_GOOGLE_CLIENT_SECRET: googleSecret,
    };
    const lookup = createEnvCredentialLookup(env);
    expect(lookup('platform-a', 'google')).toEqual({
      clientKey: googleKey,
      clientSecret: googleSecret,
    });
    expect(lookup('platform-a', 'facebook')).toBeNull();

    const renamed = createEnvCredentialLookup(
      { PLATFORM_A_GOOGLE_ID: googleKey, PLATFORM_A_GOOGLE_SECRET: googleSecret },
      {
        google: {
          clientKeyRef: 'PLATFORM_A_GOOGLE_ID',
          clientSecretRef: 'PLATFORM_A_GOOGLE_SECRET',
        },
      },
    );
    expect(renamed('platform-a', 'google')?.clientKey).toBe(googleKey);
  });

  it('masks the public client id in output', () => {
    const masked = maskClientKey(googleKey);
    expect(masked.startsWith('***')).toBe(true);
    expect(masked).not.toContain('apps.googleusercontent');
    expect(maskClientKey('abc')).toBe('***');
  });
});

describe('secrets file', () => {
  it('parses the documented shape and lets the file win over the environment', () => {
    const parsed = parseSecretsFile({
      apps: {
        'platform-a': { google: { clientKey: googleKey, clientSecret: googleSecret } },
      },
    });
    expect(parsed.ok).toBe(true);
    const lookup = combineCredentialLookups(
      parsed.secrets,
      createEnvCredentialLookup({
        IDPN_SOCIAL_PLATFORM_A_GOOGLE_CLIENT_KEY: 'from-env',
        IDPN_SOCIAL_PLATFORM_A_GOOGLE_CLIENT_SECRET: 'from-env',
      }),
    );
    expect(lookup('platform-a', 'google')).toEqual({
      clientKey: googleKey,
      clientSecret: googleSecret,
    });
  });

  it('reports a problem without echoing a value', () => {
    const parsed = parseSecretsFile({ apps: { 'platform-a': { google: { clientKey: 1 } } } });
    expect(parsed.ok).toBe(false);
    expect(parsed.problems.join(' ')).not.toContain('GOCSPX');
    expect(parsed.problems.join(' ')).toContain('clientSecret');
  });
});

describe('guards', () => {
  it('resolves the callback base exactly like the Auth Server', () => {
    expect(
      resolveCallbackBase({
        SOCIAL_CALLBACK_BASE_URL: 'https://login.example.com/',
        APP_URL: 'https://auth.example.com',
      }),
    ).toBe('https://login.example.com');
    expect(
      resolveCallbackBase({ SOCIAL_CALLBACK_BASE_URL: '', APP_URL: 'https://auth.example.com' }),
    ).toBe('https://auth.example.com');
    expect(resolveCallbackBase({})).toBeNull();
  });

  it('refuses a production run without --confirm', () => {
    expect(productionConfirmationProblem('production', false)).toContain('--confirm');
    expect(productionConfirmationProblem('production', true)).toBeNull();
    expect(productionConfirmationProblem('staging', false)).toBeNull();
  });

  it('requires https callbacks outside local development', () => {
    const https = 'https://auth.example.com/oauth2/social/platform-a/google/callback';
    expect(callbackUrlProblem(https, 'production')).toBeNull();
    expect(
      callbackUrlProblem(
        'http://localhost:3000/oauth2/social/platform-a/google/callback',
        'development',
      ),
    ).toBeNull();
    expect(
      callbackUrlProblem(
        'http://auth.example.com/oauth2/social/platform-a/google/callback',
        'production',
      ),
    ).toContain('must use https');
    expect(callbackUrlProblem('not a url', 'development')).toContain('not a valid URL');
  });
});
