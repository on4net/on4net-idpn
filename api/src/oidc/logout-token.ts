import { randomUUID } from 'node:crypto';

import type { SigningKeyManager } from './keys.js';

/** The only event a back-channel Logout Token may carry (OIDC Back-Channel Logout 1.0). */
export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/** Logout tokens are one-shot and short lived (docs/auth-flows.md 4.1). */
export const LOGOUT_TOKEN_TTL_SECONDS = 120;

/** A collision is practically impossible; three attempts still keeps issuance bounded. */
const MAX_JTI_ATTEMPTS = 3;

const LOGOUT_JTI_KEY_PREFIX = 'idpn:logout-jti:';

export interface LogoutTokenClaimsInput {
  issuer: string;
  clientId: string;
  /** IdP session id; the claim clients use to identify their local session. */
  sid: string;
  /** Subject the session belongs to; omitted only when the session has no user. */
  sub?: string;
  jti: string;
  issuedAt: number;
  ttlSeconds?: number;
}

/**
 * Logout Token claims (docs/auth-flows.md 6.3).
 *
 * There is deliberately no `nonce`: a Logout Token carrying one must be rejected by the
 * client. `events` includes the back-channel logout event so the receiver can verify intent.
 */
export function buildLogoutTokenClaims(input: LogoutTokenClaimsInput): Record<string, unknown> {
  const ttl = input.ttlSeconds ?? LOGOUT_TOKEN_TTL_SECONDS;
  return {
    iss: input.issuer,
    aud: input.clientId,
    iat: input.issuedAt,
    exp: input.issuedAt + ttl,
    jti: input.jti,
    ...(input.sub === undefined ? {} : { sub: input.sub }),
    sid: input.sid,
    events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
  };
}

/** Claims a `jti` exactly once so a Logout Token cannot be replayed (T22). */
export interface LogoutTokenJtiRegistry {
  claim(jti: string, ttlSeconds: number): Promise<boolean>;
}

/** In-memory registry for unit tests and single-process development. */
export class MemoryLogoutTokenJtiRegistry implements LogoutTokenJtiRegistry {
  private readonly claimed = new Map<string, number>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async claim(jti: string, ttlSeconds: number): Promise<boolean> {
    const nowMs = this.now().getTime();
    for (const [key, expiresAt] of this.claimed) {
      if (expiresAt <= nowMs) {
        this.claimed.delete(key);
      }
    }
    if (this.claimed.has(jti)) {
      return false;
    }
    this.claimed.set(jti, nowMs + Math.max(1, ttlSeconds) * 1000);
    return true;
  }
}

/** Subset of the Redis client used for atomic jti claims. */
export interface RedisSetNx {
  set(key: string, value: string, mode: 'EX', seconds: number, nx: 'NX'): Promise<'OK' | null>;
}

/**
 * Redis-backed jti registry. `SET key 1 EX ttl NX` is atomic, so two concurrent logouts can
 * never both claim the same jti.
 */
export class RedisLogoutTokenJtiRegistry implements LogoutTokenJtiRegistry {
  constructor(private readonly redis: RedisSetNx) {}

  async claim(jti: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(
      `${LOGOUT_JTI_KEY_PREFIX}${jti}`,
      '1',
      'EX',
      Math.max(1, Math.ceil(ttlSeconds)),
      'NX',
    );
    return result === 'OK';
  }
}

export interface LogoutTokenSignerOptions {
  issuer: string;
  keys: Pick<SigningKeyManager, 'signAccessToken'>;
  registry: LogoutTokenJtiRegistry;
  ttlSeconds?: number;
  /** Injection point for deterministic tests. */
  jtiFactory?: () => string;
  now?: () => Date;
}

export interface IssueLogoutTokenInput {
  clientId: string;
  sid: string;
  sub?: string;
}

/**
 * Issues one signed ES256 Logout Token per participating client. The jti is claimed in the
 * registry *before* the token leaves the process, so a replay of an issued token is visible
 * and a collision is regenerated instead of silently reusing an id.
 */
export class LogoutTokenSigner {
  private readonly ttlSeconds: number;
  private readonly jtiFactory: () => string;
  private readonly now: () => Date;

  constructor(private readonly options: LogoutTokenSignerOptions) {
    this.ttlSeconds = options.ttlSeconds ?? LOGOUT_TOKEN_TTL_SECONDS;
    this.jtiFactory = options.jtiFactory ?? (() => `logout-${randomUUID()}`);
    this.now = options.now ?? (() => new Date());
  }

  async issue(input: IssueLogoutTokenInput): Promise<string> {
    for (let attempt = 1; attempt <= MAX_JTI_ATTEMPTS; attempt += 1) {
      const jti = this.jtiFactory();
      const claimed = await this.options.registry.claim(jti, this.ttlSeconds);
      if (!claimed) {
        continue;
      }

      const issuedAt = Math.floor(this.now().getTime() / 1000);
      return this.options.keys.signAccessToken(
        buildLogoutTokenClaims({
          issuer: this.options.issuer,
          clientId: input.clientId,
          sid: input.sid,
          ...(input.sub === undefined ? {} : { sub: input.sub }),
          jti,
          issuedAt,
          ttlSeconds: this.ttlSeconds,
        }),
        {
          issuer: this.options.issuer,
          audience: input.clientId,
          ...(input.sub === undefined ? {} : { subject: input.sub }),
          expiresInSeconds: this.ttlSeconds,
          issuedAt,
        },
      );
    }

    throw new Error('could not allocate a unique logout token jti');
  }
}
