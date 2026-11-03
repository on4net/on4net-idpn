import { describe, expect, it } from 'vitest';

import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaSocialLoginRepository } from './prisma-social-login-repository.js';

const userRow = (username: string) => ({
  id: 'user-1',
  tenantId: 'tenant-1',
  username,
  email: 'new.person@example.com',
});

function fakePrisma(options: { failures: number; existingByEmail?: boolean }) {
  const created: string[] = [];
  let remaining = options.failures;
  const prisma = {
    user: {
      findUnique: async (args: { where: Record<string, unknown> }) => {
        if ('tenantId_email' in args.where) {
          return options.existingByEmail === true ? userRow('existing') : null;
        }
        return null;
      },
      create: async (args: { data: { username: string } }) => {
        created.push(args.data.username);
        if (remaining > 0) {
          remaining -= 1;
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        return userRow(args.data.username);
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, created };
}

const input = {
  tenantId: 'tenant-1',
  email: 'New.Person@example.com',
  displayName: 'New Person',
  avatarUrl: null,
  locale: 'fa-IR',
  emailVerified: true,
  now: new Date('2026-10-25T10:00:00Z'),
} as const;

describe('createUser unique violations', () => {
  it('retries with a fresh username when the username, not the e-mail, collided', async () => {
    const { prisma, created } = fakePrisma({ failures: 1 });
    const result = await createPrismaSocialLoginRepository(prisma).createUser(input);

    expect(result.created).toBe(true);
    expect(created).toHaveLength(2);
    expect(created[1]).not.toBe(created[0]);
    expect(created[1]).toMatch(/^new\.person-[0-9a-f]{8}$/);
  });

  it('hands an existing e-mail owner to the policy instead of retrying', async () => {
    const { prisma, created } = fakePrisma({ failures: 1, existingByEmail: true });
    const result = await createPrismaSocialLoginRepository(prisma).createUser(input);

    expect(result.created).toBe(false);
    expect(result.user.id).toBe('user-1');
    expect(created).toHaveLength(1);
  });

  it('gives up after three attempts instead of looping', async () => {
    const { prisma, created } = fakePrisma({ failures: 10 });
    await expect(createPrismaSocialLoginRepository(prisma).createUser(input)).rejects.toMatchObject(
      { code: 'P2002' },
    );
    expect(created).toHaveLength(3);
  });
});
