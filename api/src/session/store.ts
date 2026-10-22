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
  /**
   * Called when a read slid the idle timeout, so the PostgreSQL mirror (admin lists, the
   * active-session gauge) sees the same expiry as Redis. Throttled per `sid`.
   */
  onSlide?: (session: IdpSession) => Promise<void> | void;
  /** Minimum seconds between two mirrored slides of one sid (default 60). */
  slideMirrorIntervalSeconds?: number;
}

const SESSION_KEY = 'idpn:sess:';
const USER_SESSIONS_KEY = 'idpn:user-sessions:';
const USER_REVOKED_KEY = 'idpn:user-revoked:';

/** Per-user revocation marker: `at` is epoch-ms, `keep` the one sid the revocation spared. */
interface UserRevocation {
  at: number;
  reason: RevokeReason;
  keep?: string;
}

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
  private readonly onSlide: ((session: IdpSession) => Promise<void> | void) | undefined;
  private readonly slideMirrorIntervalMs: number;
  /** Last time each sid was mirrored, so a busy session does not write on every request. */
  private readonly lastSlideMirrorAt = new Map<string, number>();

  constructor(options: SessionStoreOptions) {
    this.cache = options.cache;
    this.policy = options.policy;
    this.now = options.now ?? (() => new Date());
    this.onRevoked = options.onRevoked;
    this.onSlide = options.onSlide;
    this.slideMirrorIntervalMs = (options.slideMirrorIntervalSeconds ?? 60) * 1000;
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
      absoluteExpiresAt: (input.absoluteExpiresAt ?? new Date(now.getTime() + this.policy.absoluteTtlSeconds * 1000)).toISOString(),
      ...definedOptional('ip', input.ip),
      ...definedOptional('userAgent', input.userAgent),
      amr: [...input.amr],
      acr: input.acr,
    };

    await this.persistIndexed(session);
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

    // A global revocation also kills sessions the user index lost (an evicted index key, an
    // older writer). One extra GET per read buys that guarantee (card #70 finding 5b).
    const revocation = await this.userRevocation(session.userId);
    if (revocation !== null && revocation.keep !== session.sid) {
      // `<=` on purpose: a session created in the same millisecond as the revocation is treated
      // as revoked. Dying too eagerly costs one login, surviving costs a valid session.
      if (Date.parse(session.createdAt) <= revocation.at) {
        await this.markRevoked(session, revocation.reason);
        return null;
      }
    }

    const idleExpiresAt = new Date(now.getTime() + this.policy.idleTtlSeconds * 1000);
    const absolute = new Date(session.absoluteExpiresAt);
    const next: IdpSession = {
      ...session,
      lastSeenAt: now.toISOString(),
      idleExpiresAt: (idleExpiresAt < absolute ? idleExpiresAt : absolute).toISOString(),
    };
    await this.persist(next);
    // Fire-and-forget: the PostgreSQL mirror is derived state, so it must not add a database
    // round-trip to the session read path of every authenticated request (card #73 finding 4).
    void this.mirrorSlide(next).catch(() => {
      // `mirrorSlide` already swallows its own failures; this is defence in depth.
    });
    return next;
  }

  /**
   * Write-behind of the idle slide into the PostgreSQL mirror. Without it the row keeps the
   * creation-time expiry, so after one idle window the Admin API reports no active session
   * and the `idpn_active_sessions` gauge under-counts. Throttled and best effort: a mirror
   * failure must never fail the request that read the session.
   */
  private async mirrorSlide(session: IdpSession): Promise<void> {
    if (this.onSlide === undefined) {
      return;
    }
    const at = this.now().getTime();
    const last = this.lastSlideMirrorAt.get(session.sid) ?? 0;
    if (at - last < this.slideMirrorIntervalMs) {
      return;
    }
    this.lastSlideMirrorAt.set(session.sid, at);
    try {
      await this.onSlide(session);
    } catch {
      // The mirror is derived state; the authoritative session is already in Redis.
      this.lastSlideMirrorAt.delete(session.sid);
    }
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
      // The hard limit is measured from the original authentication, never from the rotation.
      absoluteExpiresAt: new Date(current.absoluteExpiresAt),
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

  /**
   * Records the Login Context the session is currently acting in
   * (`docs/login-contexts.md` 3.4). The session id, `auth_time`, `acr` and `amr` are kept:
   * switching context is not a new authentication, and the step-up checks keep looking at
   * the time the user actually proved a factor. Returns `null` for an inactive session.
   */
  async rebindContext(sid: string, loginContext: string): Promise<IdpSession | null> {
    const current = await this.read(sid);
    if (current === null) {
      return null;
    }
    const next: IdpSession = { ...current, loginContext };
    await this.persist(next);
    return next;
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
    // The epoch is written first: from this instant on, even a session the index does not
    // list is rejected when it is read.
    await this.writeUserRevocation(userId, { at: this.now().getTime(), reason });
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
    await this.writeUserRevocation(userId, {
      at: this.now().getTime(),
      reason,
      keep: keepSid,
    });
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
   * Revokes only the sessions created for one app. Used when an app membership is
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
   * Revokes only the sessions created for one Login Context of one app
   * (docs/login-contexts.md 3.4). Another context of the same app keeps its session, and the
   * returned `sid`s let the caller mirror the exact revocation into PostgreSQL.
   */
  async revokeForUserClientContext(
    userId: string,
    clientId: string,
    loginContext: string,
    reason: RevokeReason,
  ): Promise<string[]> {
    const sids = await this.cache.setMembers(userKey(userId));
    const revoked: string[] = [];
    for (const sid of sids) {
      const session = await this.load(sid);
      if (session === null || session.revokedAt !== undefined) {
        await this.cache.setRemove(userKey(userId), sid);
        continue;
      }
      if (session.clientId === clientId && session.loginContext === loginContext) {
        await this.markRevoked(session, reason);
        revoked.push(sid);
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
    // The throttle entry is only meaningful for a live session; keeping it would grow one
    // entry per sid for the process lifetime (card #73 finding 4).
    this.lastSlideMirrorAt.delete(session.sid);
    if (this.onRevoked !== undefined) {
      try {
        await this.onRevoked(revoked, reason);
      } catch {
        // Auditing must never turn a completed revocation into a failed login/logout.
      }
    }
  }

  private async persist(session: IdpSession): Promise<void> {
    await this.cache.set(
      sessionKey(session.sid),
      JSON.stringify(session),
      this.sessionTtlSeconds(session),
    );
  }

  /**
   * Stores the session and its user-index membership in one step when the cache supports it.
   * The index is what `revokeAllForUser` walks, so a session that never made it into the index
   * would survive a global logout.
   */
  private async persistIndexed(session: IdpSession): Promise<void> {
    if (this.cache.setWithIndex === undefined) {
      await this.persist(session);
      await this.cache.setAdd(userKey(session.userId), session.sid, this.policy.absoluteTtlSeconds);
      return;
    }
    await this.cache.setWithIndex({
      key: sessionKey(session.sid),
      value: JSON.stringify(session),
      ttlSeconds: this.sessionTtlSeconds(session),
      indexKey: userKey(session.userId),
      member: session.sid,
      indexTtlSeconds: this.policy.absoluteTtlSeconds,
    });
  }

  private sessionTtlSeconds(session: IdpSession): number {
    const idleRemaining = secondsBetween(this.now(), new Date(session.idleExpiresAt));
    const absoluteRemaining = secondsBetween(this.now(), new Date(session.absoluteExpiresAt));
    return Math.min(idleRemaining, absoluteRemaining);
  }

  /**
   * Per-user revocation marker. Sessions older than `at` are dead even when the user index no
   * longer lists them; `keep` names the one session the revocation spared.
   */
  private async userRevocation(userId: string): Promise<UserRevocation | null> {
    const raw = await this.cache.get(userRevokedKey(userId));
    if (raw === null) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<UserRevocation>;
      if (typeof parsed.at !== 'number' || typeof parsed.reason !== 'string') {
        return null;
      }
      return {
        at: parsed.at,
        reason: parsed.reason as RevokeReason,
        ...(parsed.keep === undefined ? {} : { keep: parsed.keep }),
      };
    } catch {
      // A corrupt marker must not block logins; the index-based revocation still applies.
      return null;
    }
  }

  private async writeUserRevocation(
    userId: string,
    revocation: UserRevocation,
  ): Promise<void> {
    await this.cache.set(
      userRevokedKey(userId),
      JSON.stringify(revocation),
      this.policy.absoluteTtlSeconds,
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
    this.lastSlideMirrorAt.delete(session.sid);
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

function userRevokedKey(userId: string): string {
  return `${USER_REVOKED_KEY}${userId}`;
}

function definedOptional<K extends keyof IdpSession>(
  key: K,
  value: IdpSession[K] | undefined,
): Pick<IdpSession, K> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Pick<IdpSession, K>);
}
