import { createHash, randomBytes, randomUUID } from 'node:crypto';

export interface RefreshTokenRecord {
  id: string;
  tokenHash: string;
  familyId: string;
  clientId: string;
  userId: string;
  sessionId: string;
  scope: string[];
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  replacedBy: string | null;
  createdAt: Date;
  /** Login Context this token is bound to; narrows roles on every refresh (T31). */
  loginContext?: string;
}

export interface RefreshTokenRepository {
  create(record: RefreshTokenRecord): Promise<void>;
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  /** Marks the token as rotated and records its successor. */
  markRotated(tokenHash: string, rotatedAt: Date, replacedById: string): Promise<boolean>;
  /** Revokes every token in a family (reuse detection, logout, password change). */
  revokeFamily(familyId: string, revokedAt: Date): Promise<number>;
  revokeByHash(tokenHash: string, revokedAt: Date): Promise<boolean>;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface IssueRefreshTokenInput {
  clientId: string;
  userId: string;
  sessionId: string;
  scope: string[];
  ttlSeconds: number;
  /** Existing family when rotating; a new family is created otherwise. */
  familyId?: string;
  /** Login Context the token must stay bound to across rotations. */
  loginContext?: string;
  now?: Date;
}

/** Creates a 256-bit opaque refresh token; only its hash is stored. */
export async function issueRefreshToken(
  repository: RefreshTokenRepository,
  input: IssueRefreshTokenInput,
): Promise<{ token: string; record: RefreshTokenRecord }> {
  const now = input.now ?? new Date();
  const token = randomBytes(32).toString('base64url');
  const record: RefreshTokenRecord = {
    id: randomUUID(),
    tokenHash: hashRefreshToken(token),
    familyId: input.familyId ?? randomUUID(),
    clientId: input.clientId,
    userId: input.userId,
    sessionId: input.sessionId,
    scope: [...input.scope],
    expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000),
    rotatedAt: null,
    revokedAt: null,
    replacedBy: null,
    createdAt: now,
    ...(input.loginContext === undefined ? {} : { loginContext: input.loginContext }),
  };

  await repository.create(record);
  return { token, record };
}

export type RefreshFailure =
  'invalid_grant' | 'reuse_detected' | 'expired' | 'revoked' | 'client_mismatch';

export type RefreshResult =
  | {
      ok: true;
      record: RefreshTokenRecord;
      /**
       * The successor that was written during rotation. The caller must return this token:
       * minting another one leaves an unreachable row in the family and points `replacedBy`
       * at the wrong successor (card #70 finding 9).
       */
      successor: { token: string; record: RefreshTokenRecord };
    }
  | { ok: false; reason: RefreshFailure; revokedFamily?: number };

export interface RotateRefreshInput {
  token: string;
  clientId: string;
  ttlSeconds: number;
  now?: Date;
}

/**
 * Rotates a refresh token:
 *  - an unknown hash, a wrong client, an expired or revoked token is rejected;
 *  - presenting an already-rotated token is **reuse**: the whole family is revoked and
 *    `invalid_grant` is returned (docs/auth-flows.md 6);
 *  - on success the old token is marked rotated and a new one in the same family is issued.
 */
export async function rotateRefreshToken(
  repository: RefreshTokenRepository,
  input: RotateRefreshInput,
): Promise<RefreshResult> {
  const validation = await validateRefreshToken(repository, input);
  if (!validation.ok) {
    return validation;
  }
  return commitRefreshRotation(repository, {
    record: validation.record,
    ttlSeconds: input.ttlSeconds,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

export type RefreshValidation =
  | { ok: true; record: RefreshTokenRecord }
  | { ok: false; reason: RefreshFailure; revokedFamily?: number };

/**
 * First half of a rotation: decides whether the presented token may still be exchanged, and
 * writes nothing that the client could observe.
 *
 * Reuse is the exception — it revokes the family immediately, because the only safe answer to
 * a replayed token is to burn the chain.
 *
 * The caller runs its session, context and permission checks between this and
 * `commitRefreshRotation`, so a dead session never leaves a successor row behind
 * (card #70 finding 3).
 */
export async function validateRefreshToken(
  repository: RefreshTokenRepository,
  input: Pick<RotateRefreshInput, 'token' | 'clientId' | 'now'>,
): Promise<RefreshValidation> {
  const now = input.now ?? new Date();
  const current = await repository.findByHash(hashRefreshToken(input.token));
  if (current === null) {
    return { ok: false, reason: 'invalid_grant' };
  }
  if (current.clientId !== input.clientId) {
    return { ok: false, reason: 'client_mismatch' };
  }

  if (current.rotatedAt !== null) {
    const revokedFamily = await repository.revokeFamily(current.familyId, now);
    return { ok: false, reason: 'reuse_detected', revokedFamily };
  }
  if (current.revokedAt !== null) {
    return { ok: false, reason: 'revoked' };
  }
  if (current.expiresAt <= now) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, record: current };
}

export type RotationCommit =
  | {
      ok: true;
      record: RefreshTokenRecord;
      successor: { token: string; record: RefreshTokenRecord };
    }
  | { ok: false; reason: 'reuse_detected'; revokedFamily: number };

export interface CommitRotationInput {
  record: RefreshTokenRecord;
  ttlSeconds: number;
  now?: Date;
}

/**
 * Second half of a rotation: writes the successor of an already validated record. Losing the
 * `markRotated` race means another exchange got there first, which is reuse by definition.
 */
export async function commitRefreshRotation(
  repository: RefreshTokenRepository,
  input: CommitRotationInput,
): Promise<RotationCommit> {
  const now = input.now ?? new Date();
  const { record } = input;

  const next = await issueRefreshToken(repository, {
    clientId: record.clientId,
    userId: record.userId,
    sessionId: record.sessionId,
    scope: record.scope,
    ttlSeconds: input.ttlSeconds,
    familyId: record.familyId,
    ...(record.loginContext === undefined ? {} : { loginContext: record.loginContext }),
    now,
  });

  const rotated = await repository.markRotated(record.tokenHash, now, next.record.id);
  if (!rotated) {
    const revokedFamily = await repository.revokeFamily(record.familyId, now);
    return { ok: false, reason: 'reuse_detected', revokedFamily };
  }

  return { ok: true, record, successor: { token: next.token, record: next.record } };
}
