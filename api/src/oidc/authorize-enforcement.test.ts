import { describe, expect, it } from 'vitest';

import type { PrismaClient } from '../generated/prisma/client.js';
import type { MfaLoginRepository } from '../mfa/mfa-types.js';
import {
  createAuthorizeAuthenticationRequirement,
  createAuthorizeMembershipStatus,
} from './authorize-enforcement.js';

type PolicyReader = Pick<
  MfaLoginRepository,
  'resolveMfaPolicy' | 'resolveStepUpRequired' | 'isAdmin'
>;

function reader(overrides: Partial<PolicyReader> = {}): PolicyReader {
  return {
    resolveMfaPolicy: async () => 'optional',
    resolveStepUpRequired: async () => false,
    isAdmin: async () => false,
    ...overrides,
  };
}

describe('createAuthorizeAuthenticationRequirement', () => {
  it('requires MFA for required_all and reports no step-up freshness', async () => {
    const resolve = createAuthorizeAuthenticationRequirement(
      reader({ resolveMfaPolicy: async () => 'required_all' }),
    );

    await expect(resolve({ userId: 'user-1', clientId: 'app-a' })).resolves.toEqual({
      mfaRequired: true,
      freshAuthenticationRequired: false,
    });
  });

  it('requires MFA for required_admins only when the user is an admin', async () => {
    const admin = createAuthorizeAuthenticationRequirement(
      reader({ resolveMfaPolicy: async () => 'required_admins', isAdmin: async () => true }),
    );
    const regular = createAuthorizeAuthenticationRequirement(
      reader({ resolveMfaPolicy: async () => 'required_admins', isAdmin: async () => false }),
    );

    expect(await admin({ userId: 'admin', clientId: 'app-a' })).toEqual({
      mfaRequired: true,
      freshAuthenticationRequired: false,
    });
    expect(await regular({ userId: 'user-1', clientId: 'app-a' })).toEqual({
      mfaRequired: false,
      freshAuthenticationRequired: false,
    });
  });

  it('requires MFA and fresh authentication for a step-up context', async () => {
    const resolve = createAuthorizeAuthenticationRequirement(
      reader({ resolveStepUpRequired: async () => true }),
    );

    await expect(
      resolve({ userId: 'user-1', clientId: 'app-a', loginContext: 'customer-admin' }),
    ).resolves.toEqual({ mfaRequired: true, freshAuthenticationRequired: true });
  });

  it('reads the policy for the requested login context', async () => {
    const seen: { clientId?: string | undefined; loginContext?: string | undefined }[] = [];
    const resolve = createAuthorizeAuthenticationRequirement(
      reader({
        resolveMfaPolicy: async (input) => {
          seen.push(input);
          return 'optional';
        },
      }),
    );

    await resolve({ userId: 'user-1', clientId: 'app-a', loginContext: 'customer-admin' });

    expect(seen).toEqual([{ clientId: 'app-a', loginContext: 'customer-admin' }]);
  });
});

describe('createAuthorizeMembershipStatus', () => {
  interface MembershipQuery {
    clientId: string;
    userId: string;
    loginContextId: string | null;
  }

  function fakePrisma(input: {
    client: { id: string } | null;
    context?: { id: string } | null;
    membership?: { status: 'invited' | 'active' | 'suspended' } | null;
  }): { prisma: PrismaClient; queries: MembershipQuery[] } {
    const queries: MembershipQuery[] = [];
    const prisma = {
      client: { findUnique: async () => input.client },
      clientLoginContext: { findFirst: async () => input.context ?? null },
      clientMembership: {
        findFirst: async ({ where }: { where: MembershipQuery }) => {
          queries.push(where);
          return input.membership ?? null;
        },
      },
    } as unknown as PrismaClient;
    return { prisma, queries };
  }

  it('returns null when the client does not exist', async () => {
    const { prisma } = fakePrisma({ client: null });
    await expect(
      createAuthorizeMembershipStatus(prisma)({ userId: 'user-1', clientId: 'missing' }),
    ).resolves.toBeNull();
  });

  it('reads the client-wide membership when no context is requested', async () => {
    const { prisma, queries } = fakePrisma({
      client: { id: 'uuid-a' },
      membership: { status: 'active' },
    });

    await expect(
      createAuthorizeMembershipStatus(prisma)({ userId: 'user-1', clientId: 'app-a' }),
    ).resolves.toBe('active');
    expect(queries).toEqual([{ clientId: 'uuid-a', userId: 'user-1', loginContextId: null }]);
  });

  it('scopes the lookup to the requested context', async () => {
    const { prisma, queries } = fakePrisma({
      client: { id: 'uuid-a' },
      context: { id: 'context-uuid' },
      membership: { status: 'suspended' },
    });

    await expect(
      createAuthorizeMembershipStatus(prisma)({
        userId: 'user-1',
        clientId: 'app-a',
        loginContext: 'customer-admin',
      }),
    ).resolves.toBe('suspended');
    expect(queries).toEqual([
      { clientId: 'uuid-a', userId: 'user-1', loginContextId: 'context-uuid' },
    ]);
  });

  it('returns null when the context membership is missing', async () => {
    const { prisma } = fakePrisma({ client: { id: 'uuid-a' }, context: { id: 'context-uuid' } });

    await expect(
      createAuthorizeMembershipStatus(prisma)({
        userId: 'user-1',
        clientId: 'app-a',
        loginContext: 'customer-admin',
      }),
    ).resolves.toBeNull();
  });
});
