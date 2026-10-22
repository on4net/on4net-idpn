import { createOpaqueToken, hashOpaqueToken } from '../auth/opaque-token.js';

/** Purposes fixed by docs/auth-flows.md 8.2-8.4. */
export type AccountTokenPurpose = 'invite' | 'email_verification' | 'password_reset';

/** Invite 72h, email verification 24h, password reset 30m. */
export const ACCOUNT_TOKEN_TTL_MS: Readonly<Record<AccountTokenPurpose, number>> = Object.freeze({
  invite: 72 * 60 * 60 * 1000,
  email_verification: 24 * 60 * 60 * 1000,
  password_reset: 30 * 60 * 1000,
});

export interface AccountTokenRecord {
  userId: string;
  purpose: AccountTokenPurpose;
  expiresAt: Date;
  consumedAt: Date | null;
}

/** Persistence port; only hashes are persisted (never the emailed token). */
export interface AccountTokenStore {
  create(input: {
    userId: string;
    purpose: AccountTokenPurpose;
    tokenHash: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<void>;
  /** Marks every unconsumed token of the same purpose as used (one active token per user). */
  invalidateActive(userId: string, purpose: AccountTokenPurpose, at: Date): Promise<number>;
  findByHash(tokenHash: string): Promise<AccountTokenRecord | null>;
  /**
   * Conditional update: consumes the token only while it is unconsumed, unexpired, of the
   * requested purpose and (when supplied) owned by the expected user.
   */
  consume(
    tokenHash: string,
    purpose: AccountTokenPurpose,
    at: Date,
    expectedUserId?: string,
  ): Promise<TokenConsumption>;
  /**
   * Deletes tokens that were consumed or expired longer than the retention window ago, so the
   * table cannot grow without bound (and a hard user delete is not blocked by old rows).
   */
  purge(input: { now: Date; retainDays?: number }): Promise<number>;
}

export type TokenFailure = 'invalid' | 'expired' | 'used' | 'wrong_user';

export type TokenConsumption = { ok: true; userId: string } | { ok: false; reason: TokenFailure };

export interface IssuedAccountToken {
  /** Emailed once; never persisted and never logged. */
  token: string;
  expiresAt: Date;
}

/** Default retention for consumed/expired account tokens (docs/domain-model.md 4). */
export const ACCOUNT_TOKEN_RETENTION_DAYS = 30;

export async function issueAccountToken(
  store: AccountTokenStore,
  input: { userId: string; purpose: AccountTokenPurpose },
  now: () => Date = () => new Date(),
): Promise<IssuedAccountToken> {
  const at = now();
  // A resend invalidates the previous link so an old mail cannot be replayed.
  await store.invalidateActive(input.userId, input.purpose, at);
  const { token, hash } = createOpaqueToken();
  const expiresAt = new Date(at.getTime() + ACCOUNT_TOKEN_TTL_MS[input.purpose]);
  await store.create({
    userId: input.userId,
    purpose: input.purpose,
    tokenHash: hash,
    expiresAt,
    createdAt: at,
  });
  return { token, expiresAt };
}

/** Inspects a token without consuming it (used to validate a password before spending it). */
export async function peekAccountToken(
  store: AccountTokenStore,
  token: string,
  purpose: AccountTokenPurpose,
  options: {
    now?: () => Date;
    expectedUserId?: string;
  } = {},
): Promise<TokenConsumption> {
  const at = options.now?.() ?? new Date();
  const record = await store.findByHash(hashOpaqueToken(token));
  return evaluateToken(record, purpose, at, options.expectedUserId);
}

/**
 * Consumes a token atomically. A wrong-user attempt is rejected without consuming the token
 * so the legitimate holder can still use it.
 */
export async function consumeAccountToken(
  store: AccountTokenStore,
  token: string,
  purpose: AccountTokenPurpose,
  options: {
    now?: () => Date;
    expectedUserId?: string;
  } = {},
): Promise<TokenConsumption> {
  const at = options.now?.() ?? new Date();
  const hash = hashOpaqueToken(token);
  if (options.expectedUserId !== undefined) {
    // A token bound to another user must not be spent by the caller presenting it.
    const inspected = await peekAccountToken(store, token, purpose, {
      now: () => at,
      expectedUserId: options.expectedUserId,
    });
    if (!inspected.ok) {
      return inspected;
    }
  }
  return store.consume(hash, purpose, at, options.expectedUserId);
}

function evaluateToken(
  record: AccountTokenRecord | null,
  purpose: AccountTokenPurpose,
  at: Date,
  expectedUserId: string | undefined,
): TokenConsumption {
  if (record === null || record.purpose !== purpose) {
    return { ok: false, reason: 'invalid' };
  }
  if (record.consumedAt !== null) {
    return { ok: false, reason: 'used' };
  }
  if (record.expiresAt.getTime() <= at.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  if (expectedUserId !== undefined && record.userId !== expectedUserId) {
    return { ok: false, reason: 'wrong_user' };
  }
  return { ok: true, userId: record.userId };
}
