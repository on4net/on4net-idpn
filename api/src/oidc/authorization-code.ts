import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const AUTHORIZATION_CODE_TTL_SECONDS = 60;

export interface AuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  userId: string;
  sessionId: string;
  redirectUri: string;
  scope: string[];
  nonce: string | null;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  authTime: Date;
  acr: string;
  amr: string[];
  expiresAt: Date;
  consumedAt: Date | null;
  loginContext?: string;
}

export interface AuthorizationCodeRepository {
  create(record: AuthorizationCodeRecord): Promise<void>;
  findByHash(codeHash: string): Promise<AuthorizationCodeRecord | null>;
  markConsumed(codeHash: string, consumedAt: Date): Promise<boolean>;
  /** Deletes codes that expired before `before`; returns how many rows were removed. */
  purgeExpired?(before: Date): Promise<number>;
}

export interface CreateCodeInput {
  clientId: string;
  userId: string;
  sessionId: string;
  redirectUri: string;
  scope: string[];
  nonce?: string;
  codeChallenge: string;
  authTime: Date;
  acr: string;
  amr: string[];
  loginContext?: string;
  now?: Date;
}

/** Issues a 256-bit opaque code; only its SHA-256 digest is persisted. */
export async function issueAuthorizationCode(
  repository: AuthorizationCodeRepository,
  input: CreateCodeInput,
): Promise<{ code: string; record: AuthorizationCodeRecord }> {
  const now = input.now ?? new Date();
  const code = randomBytes(32).toString('base64url');
  const record: AuthorizationCodeRecord = {
    codeHash: hashCode(code),
    clientId: input.clientId,
    userId: input.userId,
    sessionId: input.sessionId,
    redirectUri: input.redirectUri,
    scope: [...input.scope],
    nonce: input.nonce ?? null,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: 'S256',
    authTime: input.authTime,
    acr: input.acr,
    amr: [...input.amr],
    expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_SECONDS * 1000),
    consumedAt: null,
    ...(input.loginContext === undefined ? {} : { loginContext: input.loginContext }),
  };

  await repository.create(record);
  return { code, record };
}

export type CodeExchangeFailure =
  | 'invalid_grant'
  | 'invalid_redirect_uri'
  | 'invalid_client'
  | 'pkce_required'
  | 'code_expired'
  | 'code_already_used';

export type CodeExchangeResult =
  { ok: true; record: AuthorizationCodeRecord } | { ok: false; reason: CodeExchangeFailure };

export interface ExchangeCodeInput {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier?: string;
  now?: Date;
}

/**
 * Validates and consumes an authorization code exactly once.
 *
 * Every failure is reported to the client as `invalid_grant`; the precise reason is kept for
 * audit and tests, never for the token endpoint response.
 */
export async function exchangeAuthorizationCode(
  repository: AuthorizationCodeRepository,
  input: ExchangeCodeInput,
): Promise<CodeExchangeResult> {
  const now = input.now ?? new Date();
  const record = await repository.findByHash(hashCode(input.code));

  if (record === null) {
    return { ok: false, reason: 'invalid_grant' };
  }
  if (record.consumedAt !== null) {
    return { ok: false, reason: 'code_already_used' };
  }
  if (record.expiresAt <= now) {
    return { ok: false, reason: 'code_expired' };
  }
  if (record.clientId !== input.clientId) {
    return { ok: false, reason: 'invalid_client' };
  }
  if (record.redirectUri !== input.redirectUri) {
    return { ok: false, reason: 'invalid_redirect_uri' };
  }
  if (input.codeVerifier === undefined || input.codeVerifier === '') {
    return { ok: false, reason: 'pkce_required' };
  }
  if (!verifyPkce(input.codeVerifier, record.codeChallenge)) {
    return { ok: false, reason: 'invalid_grant' };
  }

  const consumed = await repository.markConsumed(record.codeHash, now);
  if (!consumed) {
    return { ok: false, reason: 'code_already_used' };
  }
  return { ok: true, record: { ...record, consumedAt: now } };
}

/** `BASE64URL(SHA256(ASCII(code_verifier))) === code_challenge` (RFC 7636 S256). */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
    return false;
  }
  const digest = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  const left = Buffer.from(digest, 'utf8');
  const right = Buffer.from(codeChallenge, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function s256Challenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}
