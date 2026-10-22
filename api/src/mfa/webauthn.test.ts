import { describe, expect, it, vi } from 'vitest';

import type { MfaFactorRecord, NewWebauthnCredential } from './mfa-types.js';
import {
  MemoryWebauthnChallengeStore,
  RedisWebauthnChallengeStore,
  WEBAUTHN_CHALLENGE_TTL_SECONDS,
  type WebauthnChallengeRecord,
} from './webauthn-challenge-store.js';
import type { WebauthnLibrary } from './webauthn-library.js';
import {
  WebauthnConfigError,
  beginAuthentication,
  beginRegistration,
  checkClientData,
  finishAuthentication,
  finishRegistration,
  resolveWebauthnConfig,
  type WebauthnRepository,
} from './webauthn.js';

const at = new Date('2026-10-19T10:00:00.000Z');
const userId = '8f7b4c2f-0c8b-4bde-8a32-0a3c6f1f7d11';
const tenantId = '11111111-1111-4111-8111-111111111111';
const origin = 'https://auth.example.com';
const config = resolveWebauthnConfig({ appUrl: origin, rpName: 'on4net' });

const clientData = (type: string, challenge: string, originValue = origin, crossOrigin = false) =>
  Buffer.from(JSON.stringify({ type, challenge, origin: originValue, crossOrigin })).toString(
    'base64url',
  );

const assertion = (id: string, challenge: string, originValue = origin) => ({
  id,
  rawId: id,
  type: 'public-key',
  response: { clientDataJSON: clientData('webauthn.get', challenge, originValue) },
  clientExtensionResults: {},
});

const attestation = (id: string, challenge: string, originValue = origin) => ({
  id,
  rawId: id,
  type: 'public-key',
  response: {
    clientDataJSON: clientData('webauthn.create', challenge, originValue),
    transports: ['internal', 'hybrid'],
  },
  clientExtensionResults: {},
});

function factor(overrides: Partial<MfaFactorRecord> = {}): MfaFactorRecord {
  return {
    id: 'factor-1',
    userId,
    type: 'webauthn',
    name: 'Laptop',
    secretEncrypted: null,
    credentialId: Buffer.from([1, 2, 3, 4]),
    publicKey: Buffer.from([9, 9, 9]),
    signCount: 3n,
    transports: ['internal'],
    aaguid: null,
    deviceType: 'multiDevice',
    backedUp: true,
    confirmedAt: at,
    lastUsedAt: null,
    lastUsedStep: null,
    createdAt: at,
    ...overrides,
  };
}

interface FakeLibraryOptions {
  registration?: 'verified' | 'rejected';
  authentication?: 'verified' | 'rejected';
  newCounter?: number;
}

function fakeLibrary(options: FakeLibraryOptions = {}) {
  const generateRegistrationOptions = vi.fn(async () => ({
    options: {
      rp: { name: 'on4net', id: config.rpId },
      user: { id: 'dXNlcg', name: 'sara@example.com', displayName: 'Sara' },
      challenge: 'registration-challenge',
      pubKeyCredParams: [],
      timeout: 60000,
    },
    challenge: 'registration-challenge',
  }));
  const generateAuthenticationOptions = vi.fn(async () => ({
    options: {
      challenge: 'authentication-challenge',
      rpId: config.rpId,
      allowCredentials: [],
      userVerification: 'required' as const,
    },
    challenge: 'authentication-challenge',
  }));
  const verifyRegistration = vi.fn(async () =>
    options.registration === 'rejected'
      ? { verified: false as const }
      : {
          verified: true as const,
          value: {
            id: Buffer.from([1, 2, 3, 4]).toString('base64url'),
            publicKey: new Uint8Array([7, 7, 7]),
            counter: 0,
            transports: ['internal', 'hybrid'],
            aaguid: null,
            deviceType: 'multiDevice',
            backedUp: true,
          },
        },
  );
  const verifyAuthentication = vi.fn(async () =>
    options.authentication === 'rejected'
      ? { verified: false as const }
      : { verified: true as const, value: { newCounter: options.newCounter ?? 4 } },
  );
  const library: WebauthnLibrary = {
    generateRegistrationOptions,
    generateAuthenticationOptions,
    verifyRegistration,
    verifyAuthentication,
  };
  return { library, generateRegistrationOptions, verifyRegistration, verifyAuthentication };
}

function fakeRepository(overrides: Partial<WebauthnRepository> = {}) {
  const createWebauthnCredential = vi.fn(
    async (_userId: string, credential: NewWebauthnCredential) => ({
      ok: true as const,
      factor: factor({ name: credential.name }),
    }),
  );
  const updateWebauthnCounter = vi.fn(async () => true);
  const repository: WebauthnRepository = {
    listConfirmedWebauthn: vi.fn(async () => [factor()]),
    findWebauthn: vi.fn(async () => null),
    findWebauthnByCredentialId: vi.fn(async () => factor()),
    createWebauthnCredential,
    updateWebauthnCounter,
    renameFactor: vi.fn(async () => true),
    deleteFactor: vi.fn(async () => true),
    ...overrides,
  };
  return { repository, createWebauthnCredential, updateWebauthnCounter };
}

describe('resolveWebauthnConfig', () => {
  it('derives the RP ID from APP_URL and always accepts its origin', () => {
    expect(config).toEqual({ rpId: 'auth.example.com', rpName: 'on4net', origins: [origin] });
  });

  it('accepts an allowlisted same-site origin and deduplicates it', () => {
    const resolved = resolveWebauthnConfig({
      appUrl: origin,
      allowedOrigins: ['https://app.auth.example.com', 'https://auth.example.com'],
    });
    expect(resolved.origins).toEqual([origin, 'https://app.auth.example.com']);
  });

  it('rejects an origin outside the RP ID or with a path', () => {
    expect(() =>
      resolveWebauthnConfig({ appUrl: origin, allowedOrigins: ['https://evil.example.net'] }),
    ).toThrow(WebauthnConfigError);
    expect(() =>
      resolveWebauthnConfig({ appUrl: origin, allowedOrigins: ['https://app.auth.example.com/x'] }),
    ).toThrow(WebauthnConfigError);
  });
});

describe('checkClientData', () => {
  const record: WebauthnChallengeRecord = {
    challenge: 'expected-challenge',
    userId,
    tenantId,
    ceremony: 'authentication',
    purpose: 'login',
    rpId: config.rpId,
    origins: config.origins,
    createdAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + 300_000).toISOString(),
  };

  it('accepts the expected ceremony, challenge and origin', () => {
    const checked = checkClientData(record, assertion('cred', 'expected-challenge'));
    expect(checked.ok).toBe(true);
  });

  it('rejects a different ceremony, challenge or origin', () => {
    expect(
      checkClientData(record, {
        response: { clientDataJSON: clientData('webauthn.create', 'expected-challenge') },
      }),
    ).toEqual({ ok: false, reason: 'ceremony_mismatch' });
    expect(
      checkClientData(record, {
        response: { clientDataJSON: clientData('webauthn.get', 'other') },
      }),
    ).toEqual({ ok: false, reason: 'challenge_mismatch' });
    expect(
      checkClientData(record, assertion('cred', 'expected-challenge', 'https://evil.test')),
    ).toEqual({ ok: false, reason: 'origin_not_allowed' });
  });

  it('rejects cross-origin client data and malformed input', () => {
    expect(
      checkClientData(record, {
        response: {
          clientDataJSON: clientData('webauthn.get', 'expected-challenge', origin, true),
        },
      }),
    ).toEqual({ ok: false, reason: 'cross_origin' });
    expect(checkClientData(record, { response: {} })).toEqual({
      ok: false,
      reason: 'invalid_client_data',
    });
  });
});

describe('challenge store', () => {
  it('stores a ceremony for 300 seconds and consumes it exactly once', async () => {
    let now = at.getTime();
    const store = new MemoryWebauthnChallengeStore({ now: () => now });
    const created = await store.create({
      challenge: 'challenge',
      userId,
      tenantId,
      ceremony: 'registration',
      purpose: 'enroll',
      rpId: config.rpId,
      origins: config.origins,
    });
    expect(created.record.expiresAt).toBe(
      new Date(at.getTime() + WEBAUTHN_CHALLENGE_TTL_SECONDS * 1000).toISOString(),
    );

    expect((await store.consume(created.id))?.challenge).toBe('challenge');
    expect(await store.consume(created.id)).toBeNull();

    const expired = await store.create({
      challenge: 'other',
      userId,
      tenantId,
      ceremony: 'authentication',
      purpose: 'login',
      rpId: config.rpId,
      origins: config.origins,
    });
    now += WEBAUTHN_CHALLENGE_TTL_SECONDS * 1000 + 1;
    expect(await store.consume(expired.id)).toBeNull();
  });

  it('uses an EX TTL and getdel in Redis', async () => {
    const values = new Map<string, string>();
    const redis = {
      async set(key: string, value: string, _mode: 'EX', seconds: number) {
        expect(seconds).toBe(WEBAUTHN_CHALLENGE_TTL_SECONDS);
        values.set(key, value);
        return 'OK';
      },
      async getdel(key: string) {
        const value = values.get(key) ?? null;
        values.delete(key);
        return value;
      },
    };
    const store = new RedisWebauthnChallengeStore(redis);
    const created = await store.create({
      challenge: 'challenge',
      userId,
      tenantId,
      ceremony: 'registration',
      purpose: 'enroll',
      rpId: config.rpId,
      origins: config.origins,
    });
    expect(values.size).toBe(1);
    expect((await store.consume(created.id))?.userId).toBe(userId);
    expect(await store.consume(created.id)).toBeNull();
  });
});

describe('registration ceremony', () => {
  it('stores the verified credential after checking origin and challenge', async () => {
    const challenges = new MemoryWebauthnChallengeStore();
    const { library } = fakeLibrary();
    const { repository, createWebauthnCredential } = fakeRepository();
    const deps = { config, challenges, repository, library, now: () => at };

    const begun = await beginRegistration(deps, {
      userId,
      tenantId,
      userName: 'sara@example.com',
    });
    expect(begun.ok).toBe(true);
    const finish = await finishRegistration(deps, {
      userId,
      challengeId: begun.challengeId,
      response: attestation('credential-1', 'registration-challenge'),
      name: 'Laptop',
    });
    expect(finish).toMatchObject({ ok: true, name: 'Laptop' });
    expect(createWebauthnCredential).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        name: 'Laptop',
        credentialId: Buffer.from([1, 2, 3, 4]),
        signCount: 0n,
        transports: ['internal', 'hybrid'],
        backedUp: true,
      }),
      at,
    );
  });

  it('rejects a foreign origin before calling the verifier', async () => {
    const challenges = new MemoryWebauthnChallengeStore();
    const { library, verifyRegistration } = fakeLibrary();
    const { repository, createWebauthnCredential } = fakeRepository();
    const deps = { config, challenges, repository, library };

    const begun = await beginRegistration(deps, {
      userId,
      tenantId,
      userName: 'sara@example.com',
    });
    const finish = await finishRegistration(deps, {
      userId,
      challengeId: begun.challengeId,
      response: attestation('credential-1', 'registration-challenge', 'https://evil.test'),
      name: 'Laptop',
    });
    expect(finish).toEqual({ ok: false, reason: 'origin_not_allowed' });
    expect(verifyRegistration).not.toHaveBeenCalled();
    expect(createWebauthnCredential).not.toHaveBeenCalled();
  });

  it('fails closed when the verifier throws on malformed attestation', async () => {
    const challenges = new MemoryWebauthnChallengeStore();
    const { library } = fakeLibrary();
    const throwingLibrary: WebauthnLibrary = {
      ...library,
      verifyRegistration: vi.fn(async () => {
        throw new Error('malformed CBOR');
      }),
    };
    const { repository, createWebauthnCredential } = fakeRepository();
    const deps = { config, challenges, repository, library: throwingLibrary };

    const begun = await beginRegistration(deps, {
      userId,
      tenantId,
      userName: 'sara@example.com',
    });
    const finish = await finishRegistration(deps, {
      userId,
      challengeId: begun.challengeId,
      response: attestation('credential-1', 'registration-challenge'),
      name: 'Laptop',
    });
    expect(finish).toEqual({ ok: false, reason: 'verification_failed' });
    expect(createWebauthnCredential).not.toHaveBeenCalled();
  });

  it('rejects an already consumed ceremony and a duplicate credential', async () => {
    const challenges = new MemoryWebauthnChallengeStore();
    const { library } = fakeLibrary();
    const { repository } = fakeRepository({
      createWebauthnCredential: vi.fn(async () => ({
        ok: false as const,
        reason: 'duplicate_credential' as const,
      })),
    });
    const deps = { config, challenges, repository, library };

    const begun = await beginRegistration(deps, {
      userId,
      tenantId,
      userName: 'sara@example.com',
    });
    const finish = await finishRegistration(deps, {
      userId,
      challengeId: begun.challengeId,
      response: attestation('credential-1', 'registration-challenge'),
      name: 'Laptop',
    });
    expect(finish).toEqual({ ok: false, reason: 'duplicate_credential' });

    const replayed = await finishRegistration(deps, {
      userId,
      challengeId: begun.challengeId,
      response: attestation('credential-1', 'registration-challenge'),
      name: 'Laptop',
    });
    expect(replayed).toEqual({ ok: false, reason: 'challenge_invalid' });
  });
});

describe('authentication ceremony', () => {
  async function begin(overrides: Partial<WebauthnRepository> = {}, newCounter = 4) {
    const challenges = new MemoryWebauthnChallengeStore();
    const { library, verifyAuthentication } = fakeLibrary({ newCounter });
    const { repository, updateWebauthnCounter } = fakeRepository(overrides);
    const deps = { config, challenges, repository, library };
    const begun = await beginAuthentication(deps, {
      userId,
      tenantId,
      purpose: 'login',
      mfaChallengeToken: 'mfa-challenge-token',
    });
    if (!begun.ok) {
      throw new Error('expected authentication options');
    }
    return { deps, begun, verifyAuthentication, updateWebauthnCounter };
  }

  it('advances the counter with a compare-and-set after verifying the assertion', async () => {
    const { deps, begun, updateWebauthnCounter } = await begin();
    const result = await finishAuthentication(deps, {
      userId,
      challengeId: begun.challengeId,
      response: assertion(
        Buffer.from([1, 2, 3, 4]).toString('base64url'),
        'authentication-challenge',
      ),
      purpose: 'login',
      mfaChallengeToken: 'mfa-challenge-token',
    });
    expect(result).toEqual({ ok: true, factorId: 'factor-1', newCounter: 4 });
    expect(updateWebauthnCounter).toHaveBeenCalledWith(
      'factor-1',
      userId,
      3n,
      4n,
      expect.any(Date),
    );
  });

  it('rejects a counter that does not advance (cloned authenticator)', async () => {
    const { deps, begun, updateWebauthnCounter } = await begin({}, 3);
    const result = await finishAuthentication(deps, {
      userId,
      challengeId: begun.challengeId,
      response: assertion(
        Buffer.from([1, 2, 3, 4]).toString('base64url'),
        'authentication-challenge',
      ),
      purpose: 'login',
      mfaChallengeToken: 'mfa-challenge-token',
    });
    expect(result).toEqual({ ok: false, reason: 'counter_regression' });
    expect(updateWebauthnCounter).not.toHaveBeenCalled();
  });

  it('rejects a replay that loses the counter compare-and-set', async () => {
    const { deps, begun } = await begin({
      updateWebauthnCounter: vi.fn(async () => false),
    });
    const result = await finishAuthentication(deps, {
      userId,
      challengeId: begun.challengeId,
      response: assertion(
        Buffer.from([1, 2, 3, 4]).toString('base64url'),
        'authentication-challenge',
      ),
      purpose: 'login',
      mfaChallengeToken: 'mfa-challenge-token',
    });
    expect(result).toEqual({ ok: false, reason: 'counter_regression' });
  });

  it('binds the ceremony to the pending MFA challenge and to the owning user', async () => {
    const { deps, begun, verifyAuthentication } = await begin();
    const wrongChallenge = await finishAuthentication(deps, {
      userId,
      challengeId: begun.challengeId,
      response: assertion(
        Buffer.from([1, 2, 3, 4]).toString('base64url'),
        'authentication-challenge',
      ),
      purpose: 'login',
      mfaChallengeToken: 'another-mfa-challenge',
    });
    expect(wrongChallenge).toEqual({ ok: false, reason: 'mfa_challenge_mismatch' });
    expect(verifyAuthentication).not.toHaveBeenCalled();

    const again = await begin();
    const wrongUser = await finishAuthentication(again.deps, {
      userId: '22222222-2222-4222-8222-222222222222',
      challengeId: again.begun.challengeId,
      response: assertion(
        Buffer.from([1, 2, 3, 4]).toString('base64url'),
        'authentication-challenge',
      ),
      purpose: 'login',
      mfaChallengeToken: 'mfa-challenge-token',
    });
    expect(wrongUser).toEqual({ ok: false, reason: 'challenge_invalid' });
  });

  it('fails closed when the authenticator is unknown or the assertion is invalid', async () => {
    const unknown = await begin({ findWebauthnByCredentialId: vi.fn(async () => null) });
    expect(
      await finishAuthentication(unknown.deps, {
        userId,
        challengeId: unknown.begun.challengeId,
        response: assertion('missing-credential', 'authentication-challenge'),
        purpose: 'login',
        mfaChallengeToken: 'mfa-challenge-token',
      }),
    ).toEqual({ ok: false, reason: 'credential_unknown' });

    const rejected = await begin();
    const result = await finishAuthentication(
      { ...rejected.deps, library: fakeLibrary({ authentication: 'rejected' }).library },
      {
        userId,
        challengeId: rejected.begun.challengeId,
        response: assertion(
          Buffer.from([1, 2, 3, 4]).toString('base64url'),
          'authentication-challenge',
        ),
        purpose: 'login',
        mfaChallengeToken: 'mfa-challenge-token',
      },
    );
    expect(result).toEqual({ ok: false, reason: 'verification_failed' });
  });
});
