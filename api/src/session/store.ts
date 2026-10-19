import { randomUUID } from 'node:crypto';

import type { SessionCache } from './cache.js';
import type { ClientSessionRevoker, SessionRevocationHook } from './revocation.js';
import type { CreateSessionInput, IdpSession, RevokeReason, SessionPolicy } from './types.js';

export interface SessionStoreOptions {
  cache: SessionCache;
  policy: SessionPolicy;
  now?: () => Date;
  /** Called after a session is revoked so the caller can audit it (never receives tokens). */
  onRevoked?: SessionRevocationHook;
}

const SESSION_KEY = 'idpn:sess:';
const USER_SESSIONS_KEY = 'idpn:user-sessions:';

/** Revoked sessions stay readable for this long so the reason is observable. */
const REVOKE_GRACE_SECONDS = 60;

const secondsBetween = (from: Date, to: Date): number =>
  Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 1000));

/**
 * Redis-backed IdP session store.
 *
 * - every session has a random `sid` (never derived from user input), so a fresh login
 *   cannot continue a pre-existing session id (fixation);
 * - idle timeout slides on each successful read, absolute timeout never does;
 * - revoked/expired sessions are deleted on read and treated as `null`.
 */
export class RedisSessionStore implements ClientSessionRevoker {
  private readonly cache: SessionCache;
  private readonly policy: SessionPolicy;
  private readonly now: () => Date;
  private readonly onRevoked: SessionRevocationHook | undefined;

  constructor(options: SessionStoreOptions) {
    this.cache = options.cache;
    this.policy = options.policy;
    this.now = options.now ?? (() => new Date());
    this.onRevoked = options.onRevoked;
  }

  async create(input: CreateSessionInput): Promise<IdpSession> {
    const now = this.now();
    const session: IdpSession = {
      sid: randomUUID(),
      userId: input.userId,
      ...definedOptional('tenantId', input.tenantId),
      ...definedOptional('clientId', input.clientId),
      ...definedOptional('loginContext', input.loginContext),
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      authTime: (input.authTime ?? now).toISOString(),
      idleExpiresAt: new Date(now.getTime() + this.policy.idleTtlSeconds * 1000).toISOString(),
      absoluteExpiresAt: new Date(
        now.getTime() + this.policy.absoluteTtlSeconds * 1000,
      ).toISOString(),
      ...definedOptional('ip', input.ip),
      ...definedOptional('userAgent', input.userAgent),
      amr: [...input.amr],
      acr: input.acr,
    };

    await this.persist(session);
    await this.cache.setAdd(userKey(session.userId), session.sid, this.policy.absoluteTtlSeconds);
    await this.enforceConcurrentLimit(session.userId);
    return session;
  }

  /** Reads a session, sliding the idle timeout. Returns `null` for unknown/expired/revoked ids. */
  async read(sid: string): Promise<IdpSession | null> {
    const session = await this.load(sid);
    if (session === null) {
      return null;
    }

    const now = this.now();
    if (session.revokedAt !== undefined) {
      return null;
    }
    if (isExpired(session, now)) {
      await this.delete(session);
      return null;
    }

    const idleExpiresAt = new Date(now.getTime() + this.policy.idleTtlSeconds * 1000);
    const absolute = new Date(session.absoluteExpiresAt);
    const next: IdpSession = {
      ...session,
      lastSeenAt: now.toISOString(),
      idleExpiresAt: (idleExpiresAt < absolute ? idleExpiresAt : absolute).toISOString(),
    };
    await this.persist(next);
    return next;
  }

  /**
   * Rotates the session id (used after a successful login and on privilege change):
   * the previous `sid` is revoked so it can never be reused.
   */
  async rotate(sid: string): Promise<IdpSession | null> {
    const current = await this.read(sid);
    if (current === null) {
      return null;
    }
    await this.revoke(sid, 'rotated');
    return this.create({
      userId: current.userId,
      tenantId: current.tenantId,
      clientId: current.clientId,
      loginContext: current.loginContext,
      ip: current.ip,
      userAgent: current.userAgent,
      amr: current.amr,
      acr: current.acr,
      authTime: new Date(current.authTime),
    });
  }

  /**
   * Rotates the session id and records a fresh multi-factor authentication (step-up).
   * The previous `sid` is revoked as `rotated`, so a token minted from it cannot be replayed
   * and the new `auth_time`/`acr`/`amr` reflect the second factor (`docs/auth-flows.md` 7.4).
   */
  async stepUp(
    sid: string,
    input: { amr: string[]; acr: string; authTime: Date },
  ): Promise<IdpSession | null> {
    const current = await this.read(sid);
    if (current === null) {
      return null;
    }
    await this.revoke(sid, 'rotated');
    return this.create({
      userId: current.userId,
      ...definedOptional('tenantId', current.tenantId),
      ...definedOptional('clientId', current.clientId),
      ...definedOptional('loginContext', current.loginContext),
      ...definedOptional('ip', current.ip),
      ...definedOptional('userAgent', current.userAgent),
      amr: input.amr,
      acr: input.acr,
      authTime: input.authTime,
    });
  }

  async revoke(sid: string, reason: RevokeReason): Promise<boolean> {
    const session = await this.load(sid);
    if (session === null) {
      return false;
    }
    await this.markRevoked(session, reason);
    return true;
  }

  /** Revokes every session of a user (global logout, password change, admin action). */
  async revokeAllForUser(userId: string, reason: RevokeReason): Promise<number> {
    const sids = await this.cache.setMembers(userKey(userId));
    let revoked = 0;
    for (const sid of sids) {
      const session = await this.load(sid);
      if (session !== null) {
        await this.markRevoked(session, reason);
        revoked += 1;
      }
      await this.cache.setRemove(userKey(userId), sid);
    }
    return revoked;
  }

  /**
   * Revokes every session of the user except the caller's own one. Used by the self-service
   * password change so the device that performed the change stays signed in.
   */
  async revokeAllForUserExcept(
    userId: string,
    keepSid: string,
    reason: RevokeReason,
  ): Promise<number> {
    const sids = await this.cache.setMembers(userKey(userId));
    let revoked = 0;
    for (const sid of sids) {
      if (sid === keepSid) {
        continue;
      }
      const session = await this.load(sid);
      if (session !== null) {
        await this.markRevoked(session, reason);
        revoked += 1;
      }
      await this.cache.setRemove(userKey(userId), sid);
    }
    return revoked;
  }

  /**
   * Revokes only the sessions that were created for one app. Used when an app membership is
   * suspended: sessions belonging to other apps of the same user must stay valid.
   */
  async revokeForUserClient(
    userId: string,
    clientId: string,
    reason: RevokeReason,
  ): Promise<number> {
    const sids = await this.cache.setMembers(userKey(userId));
    let revoked = 0;
    for (const sid of sids) {
      const session = await this.load(sid);
      if (session === null || session.revokedAt !== undefined) {
        await this.cache.setRemove(userKey(userId), sid);
        continue;
      }
      if (session.clientId === clientId) {
        await this.markRevoked(session, reason);
        revoked += 1;
      }
    }
    return revoked;
  }

  /**
   * Docs specify a maximum number of concurrent sessions but not the overflow behavior.
   * We keep the newest sessions and revoke the oldest ones, so a new login always succeeds
   * and the user is never locked out by stale sessions.
   */
  private async enforceConcurrentLimit(userId: string): Promise<void> {
    const max = this.policy.maxConcurrentSessions ?? 0;
    if (max <= 0) {
      return;
    }

    const sids = await this.cache.setMembers(userKey(userId));
    const now = this.now();
    const active: IdpSession[] = [];
    for (const sid of sids) {
      const session = await this.load(sid);
      if (session === null || session.revokedAt !== undefined) {
        await this.cache.setRemove(userKey(userId), sid);
        continue;
      }
      if (isExpired(session, now)) {
        await this.delete(session);
        continue;
      }
      active.push(session);
    }

    if (active.length <= max) {
      return;
    }

    active.sort((left, right) => {
      const byCreation = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      return byCreation === 0 ? left.sid.localeCompare(right.sid) : byCreation;
    });
    for (const session of active.slice(0, active.length - max)) {
      await this.markRevoked(session, 'concurrent_limit');
    }
  }

  /**
   * Keeps the revoked record for a short grace window so concurrent requests and
   * back-channel logout can observe the revoke reason, then it expires naturally.
   */
  private async markRevoked(session: IdpSession, reason: RevokeReason): Promise<void> {
    const revoked: IdpSession = {
      ...session,
      revokedAt: this.now().toISOString(),
      revokeReason: reason,
    };
    await this.cache.set(sessionKey(session.sid), JSON.stringify(revoked), REVOKE_GRACE_SECONDS);
    await this.cache.setRemove(userKey(session.userId), session.sid);
    if (this.onRevoked !== undefined) {
      try {
        await this.onRevoked(revoked, reason);
      } catch {
        // Auditing must never turn a completed revocation into a failed login/logout.
      }
    }
  }

  private async persist(session: IdpSession): Promise<void> {
    const idleRemaining = secondsBetween(this.now(), new Date(session.idleExpiresAt));
    const absoluteRemaining = secondsBetween(this.now(), new Date(session.absoluteExpiresAt));
    await this.cache.set(
      sessionKey(session.sid),
      JSON.stringify(session),
      Math.min(idleRemaining, absoluteRemaining),
    );
  }

  private async load(sid: string): Promise<IdpSession | null> {
    const raw = await this.cache.get(sessionKey(sid));
    if (raw === null) {
      return null;
    }
    try {
      return JSON.parse(raw) as IdpSession;
    } catch {
      await this.cache.delete(sessionKey(sid));
      return null;
    }
  }

  private async delete(session: IdpSession): Promise<void> {
    await this.cache.delete(sessionKey(session.sid));
    await this.cache.setRemove(userKey(session.userId), session.sid);
  }
}

function isExpired(session: IdpSession, now: Date): boolean {
  return new Date(session.idleExpiresAt) <= now || new Date(session.absoluteExpiresAt) <= now;
}

function sessionKey(sid: string): string {
  return `${SESSION_KEY}${sid}`;
}

function userKey(userId: string): string {
  return `${USER_SESSIONS_KEY}${userId}`;
}

function definedOptional<K extends keyof IdpSession>(
  key: K,
  value: IdpSession[K] | undefined,
): Pick<IdpSession, K> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Pick<IdpSession, K>);
}
