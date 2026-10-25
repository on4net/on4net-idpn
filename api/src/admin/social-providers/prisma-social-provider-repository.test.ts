import { describe, expect, it } from 'vitest';

import type { PrismaClient } from '../../generated/prisma/client.js';
import { createPrismaSocialProviderRepository } from './prisma-social-provider-repository.js';

function fakePrisma(options: { existing: boolean; failWith?: string }) {
  const failure = () => Object.assign(new Error('prisma'), { code: options.failWith });
  return {
    client: { findUnique: async () => ({ id: 'client-uuid' }) },
    clientSocialProvider: {
      findUnique: async () => (options.existing ? { id: 'row-1' } : null),
      create: async () => {
        throw failure();
      },
      update: async () => {
        throw failure();
      },
    },
  } as unknown as PrismaClient;
}

const input = {
  clientKey: 'key',
  scopes: ['openid'],
  allowedEmailDomains: [],
  enabled: true,
  clientSecretEncrypted: new Uint8Array(new ArrayBuffer(4)),
};

describe('upsert races', () => {
  it('reports a concurrent create as a conflict', async () => {
    const repository = createPrismaSocialProviderRepository(
      fakePrisma({ existing: false, failWith: 'P2002' }),
    );
    await expect(repository.upsert('app-a', 'google', input)).resolves.toEqual({
      ok: false,
      reason: 'conflict',
    });
  });

  it('reports a concurrently deleted row as not found', async () => {
    const repository = createPrismaSocialProviderRepository(
      fakePrisma({ existing: true, failWith: 'P2025' }),
    );
    await expect(repository.upsert('app-a', 'google', input)).resolves.toEqual({
      ok: false,
      reason: 'provider-not-found',
    });
  });

  it('does not swallow an unrelated database error', async () => {
    const repository = createPrismaSocialProviderRepository(
      fakePrisma({ existing: true, failWith: 'P1001' }),
    );
    await expect(repository.upsert('app-a', 'google', input)).rejects.toMatchObject({
      code: 'P1001',
    });
  });
});
