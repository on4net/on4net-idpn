import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * Why a login-context-bound code or refresh token may not be exchanged
 * (`docs/login-contexts.md` 4.1, 6 and 9).
 */
export type LoginContextAccessFailure =
  /** The key does not name a context of the requesting client (or the client is gone). */
  | 'context_not_found'
  /** The context still exists but was disabled after the code/token was issued. */
  | 'context_disabled'
  /** The user has no membership, or only an invited one, for this exact context. */
  | 'membership_required'
  /** The user's membership for this context is suspended. */
  | 'membership_suspended';

export type LoginContextAccessDecision =
  { ok: true; contextId: string } | { ok: false; reason: LoginContextAccessFailure };

export interface LoginContextAccessInput {
  userId: string;
  /** Public client id carried by the authorization code or refresh token. */
  clientId: string;
  /** Context key carried by the authorization code or refresh token. */
  loginContext: string;
}

export interface LoginContextAccessSource {
  resolve(input: LoginContextAccessInput): Promise<LoginContextAccessDecision>;
}

/**
 * Re-checks the login context at token issuance (docs/domain-model.md 2.6.2):
 * a context that was disabled or whose membership was suspended between `/authorize`
 * and `/token` (or between two refreshes) must not produce a new token.
 */
export function createPrismaLoginContextAccessSource(
  prisma: PrismaClient,
): LoginContextAccessSource {
  return {
    async resolve({ userId, clientId, loginContext }) {
      const client = await prisma.client.findUnique({
        where: { clientId },
        select: { id: true },
      });
      if (client === null) {
        return { ok: false, reason: 'context_not_found' };
      }

      const context = await prisma.clientLoginContext.findFirst({
        where: { clientId: client.id, key: loginContext },
        select: { id: true, status: true },
      });
      if (context === null) {
        return { ok: false, reason: 'context_not_found' };
      }
      if (context.status !== 'active') {
        return { ok: false, reason: 'context_disabled' };
      }

      const membership = await prisma.clientMembership.findFirst({
        where: { clientId: client.id, userId, loginContextId: context.id },
        select: { status: true },
      });
      if (membership === null) {
        return { ok: false, reason: 'membership_required' };
      }
      if (membership.status === 'suspended') {
        return { ok: false, reason: 'membership_suspended' };
      }
      if (membership.status !== 'active') {
        // `invited` proves nothing yet: only an accepted membership grants a token.
        return { ok: false, reason: 'membership_required' };
      }

      return { ok: true, contextId: context.id };
    },
  };
}
