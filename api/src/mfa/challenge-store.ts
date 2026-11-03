import { randomBytes } from 'node:crypto';

/**
 * Single-use MFA login challenges (docs/auth-flows.md 7.3).
 *
 * The challenge token is an opaque random value returned once to the browser; it is stored
 * in Redis with a short TTL and bound to the user, client, login context and `return_to`.
 * It is consumed atomically, so a captured token cannot complete a second login, and it is
 * destroyed after a small number of wrong codes so the second factor cannot be brute forced.
 */

export const MFA_CHALLENGE_TTL_SECONDS = 300;
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;

const CHALLENGE_KEY = 'idpn:mfa:challenge:';
const ATTEMPTS_KEY = 'idpn:mfa:attempts:';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

export interface MfaChallengeRecord {
  userId: string;
  tenantId: string;
  clientId?: string;
  loginContext?: string;
  returnTo?: string;
  createdAt: string;
  expiresAt: string;
}

export interface CreateMfaChallengeInput {
  userId: string;
  tenantId: string;
  clientId?: string | undefined;
  loginContext?: string | undefined;
  returnTo?: string | undefined;
  now?: Date;
}

export interface MfaChallenge {
  token: string;
  record: MfaChallengeRecord;
}

/** Result of atomically claiming one verification attempt for a challenge. */
export interface MfaAttemptReservation {
  /** 1-based attempt number claimed by this request. */
  attempt: number;
  /** The challenge record, or `null` when the challenge expired, was used or never existed. */
  record: MfaChallengeRecord | null;
  /** Whether this attempt is inside the budget and may run the verifier. */
  allowed: boolean;
}

export interface MfaChallengeStore {
  create(input: CreateMfaChallengeInput): Promise<MfaChallenge>;
  /** Reads without consuming, so a wrong code can be retried within the attempt budget. */
  read(token: string): Promise<MfaChallengeRecord | null>;
  /**
   * Claims one attempt atomically **before** verification, so concurrent requests cannot
   * all spend the same budget (`docs/security.md` T3). The attempt is counted even when the
   * code turns out to be wrong; `allowed: false` means the budget is exhausted and the
   * challenge has been destroyed.
   */
  reserve(token: string): Promise<MfaAttemptReservation>;
  /** Atomic read-and-delete. Returns `null` for an unknown, expired or already used token. */
  consume(token: string): Promise<MfaChallengeRecord | null>;
}

export function isChallengeToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

function parseRecord(raw: string): MfaChallengeRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<MfaChallengeRecord>;
    if (
      typeof parsed.userId !== 'string' ||
      typeof parsed.tenantId !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.expiresAt !== 'string'
    ) {
      return null;
    }
    return {
      userId: parsed.userId,
      tenantId: parsed.tenantId,
      ...(typeof parsed.clientId === 'string' ? { clientId: parsed.clientId } : {}),
      ...(typeof parsed.loginContext === 'string' ? { loginContext: parsed.loginContext } : {}),
      ...(typeof parsed.returnTo === 'string' ? { returnTo: parsed.returnTo } : {}),
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function buildRecord(input: CreateMfaChallengeInput): MfaChallengeRecord {
  const now = input.now ?? new Date();
  return {
    userId: input.userId,
    tenantId: input.tenantId,
    ...(input.clientId === undefined || input.clientId === '' ? {} : { clientId: input.clientId }),
    ...(input.loginContext === undefined || input.loginContext === ''
      ? {}
      : { loginContext: input.loginContext }),
    ...(input.returnTo === undefined ? {} : { returnTo: input.returnTo }),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + MFA_CHALLENGE_TTL_SECONDS * 1000).toISOString(),
  };
}

/** Structural subset of the Redis client (same style as `RedisSessionCache`). */
export interface MfaChallengeRedis {
  getdel(key: string): Promise<string | null>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** Redis-backed store used in production; safe across API instances. */
export class RedisMfaChallengeStore implements MfaChallengeStore {
  constructor(private readonly redis: MfaChallengeRedis) {}

  async create(input: CreateMfaChallengeInput): Promise<MfaChallenge> {
    const token = randomBytes(32).toString('base64url');
    const record = buildRecord(input);
    await this.redis.set(
      `${CHALLENGE_KEY}${token}`,
      JSON.stringify(record),
      'EX',
      MFA_CHALLENGE_TTL_SECONDS,
    );
    return { token, record };
  }

  async read(token: string): Promise<MfaChallengeRecord | null> {
    if (!isChallengeToken(token)) {
      return null;
    }
    const raw = await this.redis.get(`${CHALLENGE_KEY}${token}`);
    return raw === null ? null : parseRecord(raw);
  }

  async reserve(token: string): Promise<MfaAttemptReservation> {
    if (!isChallengeToken(token)) {
      return { attempt: 0, record: null, allowed: false };
    }
    const attemptsKey = `${ATTEMPTS_KEY}${token}`;
    // INCR is atomic across API instances: concurrent requests get distinct attempt numbers,
    // so at most MFA_CHALLENGE_MAX_ATTEMPTS of them may reach the verifier.
    const attempt = await this.redis.incr(attemptsKey);
    if (attempt === 1) {
      await this.redis.expire(attemptsKey, MFA_CHALLENGE_TTL_SECONDS);
    }
    const raw = await this.redis.get(`${CHALLENGE_KEY}${token}`);
    const record = raw === null ? null : parseRecord(raw);
    const allowed = record !== null && attempt <= MFA_CHALLENGE_MAX_ATTEMPTS;
    if (!allowed) {
      await this.redis.del(`${CHALLENGE_KEY}${token}`);
    }
    return { attempt, record, allowed };
  }

  async consume(token: string): Promise<MfaChallengeRecord | null> {
    if (!isChallengeToken(token)) {
      return null;
    }
    const raw = await this.redis.getdel(`${CHALLENGE_KEY}${token}`);
    await this.redis.del(`${ATTEMPTS_KEY}${token}`);
    return raw === null ? null : parseRecord(raw);
  }
}

interface Entry {
  value: MfaChallengeRecord;
  expiresAt: number;
}

/**
 * In-memory store with the same single-use and TTL semantics, for unit tests and for a
 * single-process development server.
 */
export class MemoryMfaChallengeStore implements MfaChallengeStore {
  private readonly challenges = new Map<string, Entry>();
  private readonly attempts = new Map<string, number>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  async create(input: CreateMfaChallengeInput): Promise<MfaChallenge> {
    const token = randomBytes(32).toString('base64url');
    const record = buildRecord({ ...input, now: input.now ?? new Date(this.now()) });
    this.challenges.set(token, {
      value: record,
      expiresAt: this.now() + MFA_CHALLENGE_TTL_SECONDS * 1000,
    });
    return { token, record };
  }

  async read(token: string): Promise<MfaChallengeRecord | null> {
    return this.live(token);
  }

  async reserve(token: string): Promise<MfaAttemptReservation> {
    if (!isChallengeToken(token)) {
      return { attempt: 0, record: null, allowed: false };
    }
    const attempt = (this.attempts.get(token) ?? 0) + 1;
    this.attempts.set(token, attempt);
    const record = this.live(token);
    const allowed = record !== null && attempt <= MFA_CHALLENGE_MAX_ATTEMPTS;
    if (!allowed) {
      this.challenges.delete(token);
    }
    return { attempt, record, allowed };
  }

  async consume(token: string): Promise<MfaChallengeRecord | null> {
    const record = this.live(token);
    this.challenges.delete(token);
    this.attempts.delete(token);
    return record;
  }

  private live(token: string): MfaChallengeRecord | null {
    if (!isChallengeToken(token)) {
      return null;
    }
    const entry = this.challenges.get(token);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.challenges.delete(token);
      return null;
    }
    return entry.value;
  }
}
