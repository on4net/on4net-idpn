import type { PrismaClient } from '../generated/prisma/client.js';
import { sessionProvesMultiFactor } from '../mfa/policy.js';
import type { MfaPolicy } from '../mfa/mfa-types.js';

/**
 * Moving an authenticated session from one Login Context to another
 * (`docs/login-contexts.md` 4.1, 6 and 9).
 *
 * Switching never re-enters a password: it may only succeed when the session already proves
 * the authentication strength the target context requires. Anything weaker is reported as
 * `interaction_required` so the caller can drive the standard step-up/login flow; a request
 * is never silently downgraded into the new context.
 */
export type ContextSwitchFailure =
  /** The session was not created for a client, so it has no contexts to switch between. */
  | 'no_client_context'
  /** The context does not exist for that client (or the client is gone). */
  | 'context_not_found'
  /** The context exists but is disabled. */
  | 'context_disabled'
  /** The session already acts in that context. */
  | 'already_in_context'
  /** The user has no membership, or only an invited one, for that context. */
  | 'membership_required'
  /** The membership of that context is suspended. */
  | 'membership_suspended'
  /** The target context needs a second factor or a fresher authentication than this session. */
  | 'interaction_required';

export type MembershipStatus = 'invited' | 'active' | 'suspended';

/** Authentication facts of the session that wants to switch. */
export interface ContextSwitchSessionState {
  loginContext?: string | undefined;
  amr: readonly string[];
  acr: string;
  authTime: Date;
}

export interface ContextSwitchTarget {
  /** Context UUID. */
  id: string;
  key: string;
  name: string;
  status: 'active' | 'disabled';
  mfaPolicy: MfaPolicy;
  stepUpRequired: boolean;
}

export interface ContextSwitchRepository {
  /** Internal client UUID for the public client id. */
  resolveClientId(publicClientId: string): Promise<string | null>;
  findContext(clientUuid: string, key: string): Promise<ContextSwitchTarget | null>;
  /** Active contexts of the client, in display order. */
  listContexts(clientUuid: string): Promise<ContextSwitchTarget[]>;
  /** Membership of the user for exactly one context (`null` when there is none). */
  membershipStatus(
    clientUuid: string,
    contextUuid: string,
    userId: string,
  ): Promise<MembershipStatus | null>;
}

/** Window in which a step-up context accepts the existing authentication. */
export const STEP_UP_MAX_AGE_SECONDS = 300;

export interface ContextSwitchEvaluationInput {
  session: ContextSwitchSessionState;
  target: ContextSwitchTarget;
  membership: MembershipStatus | null;
  /** The user administers this client, which matters for `mfaPolicy = required_admins`. */
  adminScoped: boolean;
  now: Date;
  stepUpMaxAgeSeconds?: number;
}

export type ContextSwitchDecision =
  { ok: true } | { ok: false; reason: ContextSwitchEvaluationFailure };

/** Failures the evaluation itself can report (the context is assumed to exist). */
export type ContextSwitchEvaluationFailure = Exclude<
  ContextSwitchFailure,
  'no_client_context' | 'context_not_found'
>;

/**
 * Decides whether the session may act in `target` without a new authentication.
 *
 * Order matters: a disabled context or a missing membership must never be masked by a
 * policy outcome, and `already_in_context` is only reported for a context the user may
 * legitimately use.
 */
export function evaluateContextSwitch(input: ContextSwitchEvaluationInput): ContextSwitchDecision {
  const { session, target, membership } = input;
  if (target.status !== 'active') {
    return { ok: false, reason: 'context_disabled' };
  }
  if (membership === null || membership === 'invited') {
    return { ok: false, reason: 'membership_required' };
  }
  if (membership === 'suspended') {
    return { ok: false, reason: 'membership_suspended' };
  }
  if (session.loginContext === target.key) {
    return { ok: false, reason: 'already_in_context' };
  }

  const maxAge = input.stepUpMaxAgeSeconds ?? STEP_UP_MAX_AGE_SECONDS;
  const mfaRequired =
    target.stepUpRequired ||
    target.mfaPolicy === 'required_all' ||
    (target.mfaPolicy === 'required_admins' && input.adminScoped);
  if (mfaRequired && !sessionProvesMultiFactor(session)) {
    return { ok: false, reason: 'interaction_required' };
  }
  if (target.stepUpRequired && input.now.getTime() - session.authTime.getTime() > maxAge * 1000) {
    return { ok: false, reason: 'interaction_required' };
  }
  return { ok: true };
}

const toTarget = (row: {
  id: string;
  key: string;
  name: string;
  status: string;
  mfaPolicy: string;
  stepUpRequired: boolean;
}): ContextSwitchTarget => ({
  id: row.id,
  key: row.key,
  name: row.name,
  status: row.status === 'active' ? 'active' : 'disabled',
  mfaPolicy: row.mfaPolicy as MfaPolicy,
  stepUpRequired: row.stepUpRequired,
});

/** Prisma-backed lookups for the self-service context switch. */
export function createPrismaContextSwitchRepository(prisma: PrismaClient): ContextSwitchRepository {
  return {
    async resolveClientId(publicClientId) {
      const client = await prisma.client.findUnique({
        where: { clientId: publicClientId },
        select: { id: true, status: true },
      });
      return client === null || client.status !== 'active' ? null : client.id;
    },

    async findContext(clientUuid, key) {
      const row = await prisma.clientLoginContext.findFirst({
        where: { clientId: clientUuid, key },
        select: {
          id: true,
          key: true,
          name: true,
          status: true,
          mfaPolicy: true,
          stepUpRequired: true,
        },
      });
      return row === null ? null : toTarget(row);
    },

    async listContexts(clientUuid) {
      const rows = await prisma.clientLoginContext.findMany({
        where: { clientId: clientUuid, status: 'active' },
        select: {
          id: true,
          key: true,
          name: true,
          status: true,
          mfaPolicy: true,
          stepUpRequired: true,
        },
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
      });
      return rows.map(toTarget);
    },

    async membershipStatus(clientUuid, contextUuid, userId) {
      const row = await prisma.clientMembership.findFirst({
        where: { clientId: clientUuid, loginContextId: contextUuid, userId },
        select: { status: true },
      });
      return row === null ? null : (row.status as MembershipStatus);
    },
  };
}
