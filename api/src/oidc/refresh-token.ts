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
  | { ok: true; record: RefreshTokenRecord }
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

  const next = await issueRefreshToken(repository, {
    clientId: current.clientId,
    userId: current.userId,
    sessionId: current.sessionId,
    scope: current.scope,
    ttlSeconds: input.ttlSeconds,
    familyId: current.familyId,
    ...(current.loginContext === undefined ? {} : { loginContext: current.loginContext }),
    now,
  });

  const rotated = await repository.markRotated(current.tokenHash, now, next.record.id);
  if (!rotated) {
    // Lost the race with another exchange of the same token: treat it as reuse.
    const revokedFamily = await repository.revokeFamily(current.familyId, now);
    return { ok: false, reason: 'reuse_detected', revokedFamily };
  }

  return { ok: true, record: current };
}
