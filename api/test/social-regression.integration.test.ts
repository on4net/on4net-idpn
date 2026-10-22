import request, { type Response as SupertestResponse } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaRbacRepository } from '../src/admin/rbac/prisma-rbac-repository.js';
import { createSecretBox, type SecretBox } from '../src/crypto/secret-box.js';
import { createPrismaLoginRepository } from '../src/login/prisma-repository.js';
import { createPrismaClientRepository } from '../src/oidc/prisma-client-repository.js';
import { createPrismaCodeRepository } from '../src/oidc/prisma-code-repository.js';
import { createPrismaRefreshTokenRepository } from '../src/oidc/prisma-refresh-repository.js';
import { createPrismaUserRepository } from '../src/oidc/prisma-user-repository.js';
import { createPrismaPublicConfigRepository } from '../src/public-config/prisma-repository.js';
import { buildServer } from '../src/server.js';
import { RedisSessionCache } from '../src/session/redis-cache.js';
import { RedisSessionStore } from '../src/session/store.js';
import { codeChallengeFor } from '../src/social/login-request.js';
import { createPrismaSocialLoginRepository } from '../src/social/prisma-social-login-repository.js';
import type { SocialLoginRepository } from '../src/social/social-login-types.js';
import { MemorySocialTransactionStore } from '../src/social/transaction-store.js';
import type {
  AuthorizationCodeExchange,
  NormalizedSocialProfile,
  SocialProviderAdapter,
  SocialProviderId,
} from '../src/social/types.js';
import { startPhase4Infra, type Phase4Infra } from './phase4-harness.js';

/**
 * Phase-4 social regression edges (docs/testing.md INT-SOCIAL-001..002, UNIT-SOCIAL-001..002):
 * per-client credentials, provider/client changes between start and callback, state TTL and
 * public provider discovery after an admin-side disable.
 *
 * The feature-card suite (`social-login.integration.test.ts`) already proves the happy path,
 * linking rules and adapter error mapping; this file does not repeat those assertions.
 */

const issuer = 'http://127.0.0.1:3400';
const secretKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const appAGoogleSecret = 'GOCSPX-regression-app-a-google';
const appAFacebookSecret = 'GOCSPX-regression-app-a-facebook';
const appBGoogleSecret = 'GOCSPX-regression-app-b-google';
const CLIENT_STATE = 'regression-client-state';
const CLIENT_NONCE = 'regression-client-nonce';
const CLIENT_CHALLENGE = 'b'.repeat(43);

let infra: Phase4Infra;
let app: ReturnType<typeof buildServer>;
let box: SecretBox;
let socialRepository: SocialLoginRepository;
let transactions: MemorySocialTransactionStore;
let appAId: string;
let appBId: string;
let clock = Date.now();

interface FakeAdapterState {
  profile: NormalizedSocialProfile | null;
  inputs: AuthorizationCodeExchange[];
  error: unknown;
}

const googleState: FakeAdapterState = { profile: null, inputs: [], error: null };
const facebookState: FakeAdapterState = { profile: null, inputs: [], error: null };

function fakeAdapter(provider: SocialProviderId, state: FakeAdapterState): SocialProviderAdapter {
  return {
    provider,
    async exchangeAuthorizationCode(input) {
      state.inputs.push(input);
      if (state.error !== null) {
        throw state.error;
      }
      if (state.profile === null) {
        throw new Error(`no ${provider} profile configured for this test`);
      }
      return state.profile;
    },
  };
}

const googleAdapter = fakeAdapter('google', googleState);
const facebookAdapter = fakeAdapter('facebook', facebookState);

const redirectUriFor = (clientId: string): string => `https://${clientId}.example/callback`;

function buildTestServer(): ReturnType<typeof buildServer> {
  const sessions = new RedisSessionStore({
    cache: new RedisSessionCache(infra.redis),
    policy: { idleTtlSeconds: 1800, absoluteTtlSeconds: 28800 },
  });
  const loginRepository = createPrismaLoginRepository(infra.prisma);

  return buildServer({
    issuer,
    keys: infra.keys,
    publicConfig: {
      repository: createPrismaPublicConfigRepository(infra.prisma),
      originLookup: async () => [],
      mfe: {
        version: '1.0.0',
        remoteEntry: 'https://cdn.example.com/1.0.0/remoteEntry.js',
      },
    },
    token: {
      clients: createPrismaClientRepository(infra.prisma),
      codes: createPrismaCodeRepository(infra.prisma),
      refreshTokens: createPrismaRefreshTokenRepository(infra.prisma),
      users: createPrismaUserRepository(infra.prisma),
      sessions,
    },
    authorize: {
      clients: createPrismaClientRepository(infra.prisma),
      loginUrl: `${issuer}/login`,
      loginRequests: {
        create: (input) => transactions.createAuthorizeLoginRequest(input),
      },
    },
    social: {
      loginUrl: `${issuer}/login`,
      repository: socialRepository,
      transactions,
      secretBox: box,
      adapters: { google: googleAdapter, facebook: facebookAdapter },
      sessions,
      persistSession: (input) => loginRepository.persistSession(input),
      audit: createPrismaAdminAudit(infra.prisma),
      cookie: { secure: false, idleTtlSeconds: 1800, absoluteTtlSeconds: 28800 },
    },
  });
}

interface StartedFlow {
  absoluteReturnTo: string;
  state: string;
  nonce: string | null;
  providerUrl: URL;
}

const profile = (
  provider: SocialProviderId,
  overrides: Partial<NormalizedSocialProfile> = {},
): NormalizedSocialProfile => ({
  provider,
  providerUserId: `${provider}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  email: `social-${Date.now()}-${Math.random().toString(16).slice(2)}@social.test`,
  emailVerified: true,
  displayName: 'Social Regression User',
  avatarUrl: null,
  locale: 'en',
  ...overrides,
});

async function startFlow(clientId: string, provider: SocialProviderId): Promise<StartedFlow> {
  const authorizeParams = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUriFor(clientId),
    scope: 'openid profile email',
    state: CLIENT_STATE,
    nonce: CLIENT_NONCE,
    code_challenge: CLIENT_CHALLENGE,
    code_challenge_method: 'S256',
  });
  const login = await request(app.server)
    .get(`/oauth2/authorize?${authorizeParams.toString()}`)
    .expect(302);
  const loginLocation = new URL(String(login.headers.location));
  const loginRequest = loginLocation.searchParams.get('login_request');
  expect(loginRequest).toBeTruthy();

  const start = await request(app.server)
    .get(`/oauth2/social/${clientId}/${provider}/start`)
    .query({ login_request: loginRequest })
    .expect(302);
  const providerUrl = new URL(String(start.headers.location));
  const state = providerUrl.searchParams.get('state');
  expect(state).toBeTruthy();

  return {
    absoluteReturnTo: new URL(loginLocation.searchParams.get('return_to') ?? '', issuer).toString(),
    state: state ?? '',
    nonce: providerUrl.searchParams.get('nonce'),
    providerUrl,
  };
}

const callback = (clientId: string, provider: SocialProviderId, flow: StartedFlow) =>
  request(app.server)
    .get(`/oauth2/social/${clientId}/${provider}/callback`)
    .query({ code: 'provider-code', state: flow.state });

const startError = async (
  clientId: string,
  provider: SocialProviderId,
): Promise<{ status: number; error: unknown }> => {
  const authorizeParams = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUriFor(clientId),
    scope: 'openid profile email',
    state: CLIENT_STATE,
    nonce: CLIENT_NONCE,
    code_challenge: CLIENT_CHALLENGE,
    code_challenge_method: 'S256',
  });
  const login = await request(app.server)
    .get(`/oauth2/authorize?${authorizeParams.toString()}`)
    .expect(302);
  const loginRequest = new URL(String(login.headers.location)).searchParams.get('login_request');
  const response = await request(app.server)
    .get(`/oauth2/social/${clientId}/${provider}/start`)
    .query({ login_request: loginRequest });
  return { status: response.status, error: response.body.error };
};

const sessionCookie = (response: SupertestResponse): string =>
  String(response.headers['set-cookie']).split(';')[0] ?? '';

beforeAll(async () => {
  infra = await startPhase4Infra('idpn_phase4_social');
  box = createSecretBox(secretKey);
  transactions = new MemorySocialTransactionStore({ now: () => clock });
  socialRepository = createPrismaSocialLoginRepository(infra.prisma, {
    rbac: createPrismaRbacRepository(infra.prisma),
  });

  const newClient = async (clientId: string, registrationPolicy: 'self_service' | 'invite_only') =>
    infra.prisma.client.create({
      data: {
        clientId,
        name: clientId,
        type: 'web',
        redirectUris: [redirectUriFor(clientId)],
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        scopes: ['openid', 'profile', 'email'],
        registrationPolicy,
        tenantId: infra.tenantId,
      },
    });

  const appA = await newClient('social-app-a', 'self_service');
  const appB = await newClient('social-app-b', 'self_service');
  appAId = appA.id;
  appBId = appB.id;

  const newProvider = (
    client: { id: string },
    provider: SocialProviderId,
    clientKey: string,
    secret: string,
  ) =>
    infra.prisma.clientSocialProvider.create({
      data: {
        clientId: client.id,
        provider,
        clientKey,
        clientSecretEncrypted: new Uint8Array(box.encrypt(secret)),
        scopes: ['openid', 'email', 'profile'],
        allowedEmailDomains: [],
      },
    });

  await newProvider(appA, 'google', 'social-app-a-google-key', appAGoogleSecret);
  await newProvider(appA, 'facebook', 'social-app-a-facebook-key', appAFacebookSecret);
  await newProvider(appB, 'google', 'social-app-b-google-key', appBGoogleSecret);
  await newProvider(appB, 'facebook', 'social-app-b-facebook-key', appAFacebookSecret);

  app = buildTestServer();
  await app.ready();
}, 300_000);

beforeEach(() => {
  googleState.profile = null;
  googleState.inputs.length = 0;
  googleState.error = null;
  facebookState.profile = null;
  facebookState.inputs.length = 0;
  facebookState.error = null;
  clock = Date.now();
});

afterAll(async () => {
  await app?.close();
  await infra?.close();
});

describe('per-client social credentials', () => {
  it.each([
    {
      clientId: 'social-app-a',
      provider: 'google' as const,
      clientKey: 'social-app-a-google-key',
      secret: appAGoogleSecret,
      state: googleState,
    },
    {
      clientId: 'social-app-a',
      provider: 'facebook' as const,
      clientKey: 'social-app-a-facebook-key',
      secret: appAFacebookSecret,
      state: facebookState,
    },
    {
      clientId: 'social-app-b',
      provider: 'google' as const,
      clientKey: 'social-app-b-google-key',
      secret: appBGoogleSecret,
      state: googleState,
    },
  ])(
    'uses only the $clientId credentials for $provider',
    async ({ clientId, provider, clientKey, secret, state }) => {
      const socialProfile = profile(provider);
      state.profile = socialProfile;

      const flow = await startFlow(clientId, provider);
      expect(flow.providerUrl.searchParams.get('client_id')).toBe(clientKey);
      expect(flow.providerUrl.searchParams.get('redirect_uri')).toBe(
        `${issuer}/oauth2/social/${clientId}/${provider}/callback`,
      );

      const response = await callback(clientId, provider, flow).expect(302);
      expect(response.headers.location).toBe(flow.absoluteReturnTo);
      expect(response.headers['set-cookie']).toBeDefined();
      expect(sessionCookie(response)).toContain('idpn_session=');

      const exchange = state.inputs.at(-1);
      expect(exchange).toMatchObject({
        code: 'provider-code',
        clientKey,
        clientSecret: secret,
        redirectUri: `${issuer}/oauth2/social/${clientId}/${provider}/callback`,
      });
      expect(codeChallengeFor(exchange?.codeVerifier ?? '')).toBe(
        flow.providerUrl.searchParams.get('code_challenge'),
      );
      // Google proves the identity with a nonce inside the ID token; Facebook has none.
      expect(exchange?.nonce).toBe(provider === 'google' ? flow.nonce : undefined);

      const identity = await infra.prisma.identity.findUnique({
        where: {
          provider_providerUserId: {
            provider,
            providerUserId: socialProfile.providerUserId,
          },
        },
        select: { userId: true },
      });
      expect(identity).not.toBeNull();
      const membership = await infra.prisma.clientMembership.findFirst({
        where: {
          clientId: clientId === 'social-app-a' ? appAId : appBId,
          userId: identity?.userId,
        },
        select: { status: true },
      });
      expect(membership?.status).toBe('active');
    },
    60_000,
  );

  it('never reuses the other app credential when the same provider is enabled twice', async () => {
    const appAProfile = profile('google');
    googleState.profile = appAProfile;
    await callback('social-app-a', 'google', await startFlow('social-app-a', 'google')).expect(302);
    const exchangesAfterA = googleState.inputs.length;

    const appBProfile = profile('google');
    googleState.profile = appBProfile;
    await callback('social-app-b', 'google', await startFlow('social-app-b', 'google')).expect(302);

    const exchanges = googleState.inputs.slice(exchangesAfterA);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.clientKey).toBe('social-app-b-google-key');
    expect(exchanges[0]?.clientSecret).toBe(appBGoogleSecret);
    expect(exchanges[0]?.clientSecret).not.toBe(appAGoogleSecret);
  }, 60_000);
});

describe('provider and client state changes between start and callback', () => {
  it('rejects a callback after the provider was disabled mid-flow and burns the state', async () => {
    googleState.profile = profile('google');
    const flow = await startFlow('social-app-a', 'google');

    await infra.prisma.clientSocialProvider.update({
      where: { clientId_provider: { clientId: appAId, provider: 'google' } },
      data: { enabled: false },
    });

    try {
      const response = await callback('social-app-a', 'google', flow).expect(302);
      const location = new URL(String(response.headers.location));
      expect(location.searchParams.get('error')).toBe('social_provider_disabled');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(googleState.inputs).toHaveLength(0);

      const replay = await callback('social-app-a', 'google', flow).expect(302);
      expect(new URL(String(replay.headers.location)).searchParams.get('error')).toBe(
        'social_state_invalid',
      );
      expect(
        await infra.prisma.identity.count({
          where: { provider: 'google', providerUserId: googleState.profile?.providerUserId },
        }),
      ).toBe(0);

      const failed = await infra.prisma.auditEvent.findFirst({
        where: {
          action: 'social.login.failed',
          clientId: appAId,
          metadata: { path: ['reason'], equals: 'provider_disabled' },
        },
        select: { metadata: true },
      });
      expect(failed?.metadata).toMatchObject({ reason: 'provider_disabled' });
    } finally {
      await infra.prisma.clientSocialProvider.update({
        where: { clientId_provider: { clientId: appAId, provider: 'google' } },
        data: { enabled: true },
      });
    }
  }, 60_000);

  it('rejects a callback after the client was disabled mid-flow', async () => {
    googleState.profile = profile('google');
    const flow = await startFlow('social-app-b', 'google');

    await infra.prisma.client.update({
      where: { id: appBId },
      data: { status: 'disabled' },
    });

    try {
      const response = await callback('social-app-b', 'google', flow).expect(302);
      expect(new URL(String(response.headers.location)).searchParams.get('error')).toBe(
        'social_provider_disabled',
      );
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(googleState.inputs).toHaveLength(0);
      expect(
        await infra.prisma.identity.count({
          where: { provider: 'google', providerUserId: googleState.profile?.providerUserId },
        }),
      ).toBe(0);
    } finally {
      await infra.prisma.client.update({
        where: { id: appBId },
        data: { status: 'active' },
      });
    }
  }, 60_000);

  it('expires the social state after the documented ten-minute TTL', async () => {
    googleState.profile = profile('google');
    const flow = await startFlow('social-app-a', 'google');

    clock += 10 * 60 * 1000 + 1;

    const response = await callback('social-app-a', 'google', flow).expect(302);
    expect(new URL(String(response.headers.location)).searchParams.get('error')).toBe(
      'social_state_invalid',
    );
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(googleState.inputs).toHaveLength(0);
  }, 60_000);
});

describe('public provider discovery isolation', () => {
  it('hides a provider only for the app it was disabled on', async () => {
    googleState.profile = null;
    await infra.prisma.clientSocialProvider.update({
      where: { clientId_provider: { clientId: appAId, provider: 'google' } },
      data: { enabled: false },
    });

    try {
      const publicA = await request(app.server)
        .get('/api/v1/clients/social-app-a/public-config')
        .expect(200);
      expect(publicA.body.socialProviders).toEqual([{ provider: 'facebook', label: 'Facebook' }]);
      expect(JSON.stringify(publicA.body)).not.toMatch(/secret|clientKey|GOCSPX/i);

      const publicB = await request(app.server)
        .get('/api/v1/clients/social-app-b/public-config')
        .expect(200);
      expect(publicB.body.socialProviders).toEqual([
        { provider: 'google', label: 'Google' },
        { provider: 'facebook', label: 'Facebook' },
      ]);

      await expect(startError('social-app-a', 'google')).resolves.toEqual({
        status: 400,
        error: 'social_provider_disabled',
      });
      // The other app's provider remains usable.
      const flow = await startFlow('social-app-b', 'google');
      expect(flow.providerUrl.searchParams.get('client_id')).toBe('social-app-b-google-key');
    } finally {
      await infra.prisma.clientSocialProvider.update({
        where: { clientId_provider: { clientId: appAId, provider: 'google' } },
        data: { enabled: true },
      });
    }
  }, 60_000);
});
