import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';

import { MemorySigningKeyRepository, SigningKeyManager } from './keys.js';
import {
  BACKCHANNEL_LOGOUT_EVENT,
  LOGOUT_TOKEN_TTL_SECONDS,
  LogoutTokenSigner,
  MemoryLogoutTokenJtiRegistry,
  buildLogoutTokenClaims,
  type LogoutTokenJtiRegistry,
} from './logout-token.js';

const issuer = 'https://auth.example.com';
const now = new Date('2026-10-18T12:00:00Z');
const issuedAt = Math.floor(now.getTime() / 1000);

async function harness(registry?: LogoutTokenJtiRegistry) {
  const keys = new SigningKeyManager(new MemorySigningKeyRepository(), () => now);
  const jtiRegistry = registry ?? new MemoryLogoutTokenJtiRegistry(() => now);
  const signer = new LogoutTokenSigner({ issuer, keys, registry: jtiRegistry, now: () => now });
  return { keys, signer };
}

describe('buildLogoutTokenClaims', () => {
  it('emits exactly the claims OIDC Back-Channel Logout requires', () => {
    const claims = buildLogoutTokenClaims({
      issuer,
      clientId: 'app-a',
      sid: '0b9f1f8a-6a1e-4d5f-9f4c-0f9f3a5b7c11',
      sub: 'user-1',
      jti: 'logout-1',
      issuedAt,
    });

    expect(claims).toEqual({
      iss: issuer,
      aud: 'app-a',
      iat: issuedAt,
      exp: issuedAt + LOGOUT_TOKEN_TTL_SECONDS,
      jti: 'logout-1',
      sub: 'user-1',
      sid: '0b9f1f8a-6a1e-4d5f-9f4c-0f9f3a5b7c11',
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    });
    expect(claims).not.toHaveProperty('nonce');
  });

  it('omits sub when the session has no subject and honours a custom ttl', () => {
    const claims = buildLogoutTokenClaims({
      issuer,
      clientId: 'app-b',
      sid: 'sid-1',
      jti: 'logout-2',
      issuedAt,
      ttlSeconds: 30,
    });

    expect(claims).not.toHaveProperty('sub');
    expect(claims['exp']).toBe(issuedAt + 30);
  });
});

describe('LogoutTokenSigner', () => {
  it('signs a verifiable ES256 token with the documented claims and no nonce', async () => {
    const { keys, signer } = await harness();

    const token = await signer.issue({ clientId: 'app-a', sid: 'sid-1', sub: 'user-1' });
    const payload = await keys.verify(token, {
      issuer,
      audience: 'app-a',
      currentDate: now,
    });

    expect(payload).toMatchObject({
      iss: issuer,
      aud: 'app-a',
      sid: 'sid-1',
      sub: 'user-1',
      iat: issuedAt,
      exp: issuedAt + LOGOUT_TOKEN_TTL_SECONDS,
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    });
    expect(payload).not.toHaveProperty('nonce');
    expect(typeof payload.jti).toBe('string');
    expect(payload.jti).toMatch(/^logout-/);
    expect(decodeJwt(token).aud).toBe('app-a');
  });

  it('rejects a token signed for another audience', async () => {
    const { keys, signer } = await harness();
    const token = await signer.issue({ clientId: 'app-a', sid: 'sid-1' });

    await expect(
      keys.verify(token, { issuer, audience: 'app-b', currentDate: now }),
    ).rejects.toThrow();
  });

  it('produces a distinct jti for every logout token', async () => {
    const { signer } = await harness();

    const first = decodeJwt(await signer.issue({ clientId: 'app-a', sid: 'sid-1' }));
    const second = decodeJwt(await signer.issue({ clientId: 'app-a', sid: 'sid-2' }));

    expect(first.jti).not.toBe(second.jti);
  });

  it('regenerates the jti when the registry reports a collision', async () => {
    let calls = 0;
    const claimed = new Set<string>();
    const registry: LogoutTokenJtiRegistry = {
      async claim(jti) {
        calls += 1;
        if (jti === 'collision') {
          return false;
        }
        if (claimed.has(jti)) {
          return false;
        }
        claimed.add(jti);
        return true;
      },
    };
    const keys = new SigningKeyManager(new MemorySigningKeyRepository(), () => now);
    const generated = ['collision', 'fresh-jti'];
    const signer = new LogoutTokenSigner({
      issuer,
      keys,
      registry,
      now: () => now,
      jtiFactory: () => generated.shift() ?? 'fallback-jti',
    });

    const token = await signer.issue({ clientId: 'app-a', sid: 'sid-1' });

    expect(calls).toBe(2);
    expect(decodeJwt(token).jti).toBe('fresh-jti');
  });

  it('fails closed when every generated jti is already claimed', async () => {
    const registry: LogoutTokenJtiRegistry = {
      async claim() {
        return false;
      },
    };
    const keys = new SigningKeyManager(new MemorySigningKeyRepository(), () => now);
    const signer = new LogoutTokenSigner({ issuer, keys, registry, now: () => now });

    await expect(signer.issue({ clientId: 'app-a', sid: 'sid-1' })).rejects.toThrow(
      /unique logout token jti/,
    );
  });
});

describe('MemoryLogoutTokenJtiRegistry', () => {
  it('claims a jti once and refuses to reuse it', async () => {
    const clock = { now };
    const registry = new MemoryLogoutTokenJtiRegistry(() => clock.now);

    await expect(registry.claim('logout-xyz', 120)).resolves.toBe(true);
    await expect(registry.claim('logout-xyz', 120)).resolves.toBe(false);

    clock.now = new Date(now.getTime() + 121_000);
    await expect(registry.claim('logout-xyz', 120)).resolves.toBe(true);
  });
});
