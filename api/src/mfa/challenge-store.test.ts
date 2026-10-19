import { describe, expect, it } from 'vitest';

import {
  MFA_CHALLENGE_MAX_ATTEMPTS,
  MemoryMfaChallengeStore,
  isChallengeToken,
} from './challenge-store.js';

const input = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  clientId: 'app-a',
  loginContext: 'customer-admin',
  returnTo: '/oauth2/authorize?client_id=app-a',
};

describe('MFA challenge store', () => {
  it('issues an opaque token bound to the login request', async () => {
    const store = new MemoryMfaChallengeStore();
    const challenge = await store.create(input);

    expect(isChallengeToken(challenge.token)).toBe(true);
    expect(challenge.token).not.toContain('user-1');
    await expect(store.read(challenge.token)).resolves.toMatchObject(input);
  });

  it('consumes the challenge exactly once', async () => {
    const store = new MemoryMfaChallengeStore();
    const { token } = await store.create(input);

    await expect(store.consume(token)).resolves.toMatchObject({ userId: 'user-1' });
    await expect(store.consume(token)).resolves.toBeNull();
    await expect(store.read(token)).resolves.toBeNull();
  });

  it('expires the challenge after the TTL', async () => {
    let now = 1_000_000;
    const store = new MemoryMfaChallengeStore({ now: () => now });
    const { token } = await store.create(input);

    now += 301_000;
    await expect(store.read(token)).resolves.toBeNull();
    await expect(store.consume(token)).resolves.toBeNull();
  });

  it('destroys the challenge after the attempt budget', async () => {
    const store = new MemoryMfaChallengeStore();
    const { token } = await store.create(input);

    for (let attempt = 1; attempt < MFA_CHALLENGE_MAX_ATTEMPTS; attempt += 1) {
      expect(await store.fail(token)).toBe(attempt);
      await expect(store.read(token)).resolves.not.toBeNull();
    }
    expect(await store.fail(token)).toBe(MFA_CHALLENGE_MAX_ATTEMPTS);
    await expect(store.read(token)).resolves.toBeNull();
  });

  it('ignores malformed tokens', async () => {
    const store = new MemoryMfaChallengeStore();
    await expect(store.read('short')).resolves.toBeNull();
    await expect(store.consume('../../etc/passwd')).resolves.toBeNull();
  });
});
