import {
  AUTHORIZE_LOGIN_REQUEST_TTL_SECONDS,
  SOCIAL_LOGIN_REQUEST_TTL_SECONDS,
  authorizeLoginTransactionSchema,
  randomToken,
  socialLoginTransactionSchema,
  type AuthorizeLoginTransaction,
  type SocialLoginTransaction,
} from './login-request.js';

/**
 * Single-use storage for the social login transactions (`docs/auth-flows.md` 9.4).
 *
 * Both records are consumed with an atomic read-and-delete, so a replayed callback can never
 * reuse a state and two tabs cannot both complete the same transaction. Expiry is enforced by
 * Redis as well as by the consumer, so an abandoned login leaves no usable record behind.
 */
export interface SocialTransactionStore {
  /** Issues an opaque `login_request` handle for one validated authorize request. */
  createAuthorizeLoginRequest(
    input: Omit<AuthorizeLoginTransaction, 'createdAt'> & { now?: Date },
  ): Promise<string>;
  takeAuthorizeLoginRequest(id: string): Promise<AuthorizeLoginTransaction | null>;
  saveSocialLoginRequest(transaction: SocialLoginTransaction): Promise<void>;
  takeSocialLoginRequest(state: string): Promise<SocialLoginTransaction | null>;
}

const AUTHORIZE_KEY = 'idpn:social:login-request:';
const SOCIAL_KEY = 'idpn:social:state:';

/** Subset of the Redis client used here, declared structurally (like `RedisSessionCache`). */
export interface SocialTransactionRedis {
  getdel(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

function parseAuthorize(raw: string): AuthorizeLoginTransaction | null {
  try {
    const parsed = authorizeLoginTransactionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseSocial(raw: string): SocialLoginTransaction | null {
  try {
    const parsed = socialLoginTransactionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Redis-backed store used in production; the key prefix keeps social records isolated. */
export class RedisSocialTransactionStore implements SocialTransactionStore {
  constructor(private readonly redis: SocialTransactionRedis) {}

  async createAuthorizeLoginRequest(
    input: Omit<AuthorizeLoginTransaction, 'createdAt'> & { now?: Date },
  ): Promise<string> {
    const id = randomToken(32);
    const record: AuthorizeLoginTransaction = {
      clientId: input.clientId,
      authorizeUrl: input.authorizeUrl,
      createdAt: (input.now ?? new Date()).toISOString(),
    };
    await this.redis.set(
      `${AUTHORIZE_KEY}${id}`,
      JSON.stringify(record),
      'EX',
      AUTHORIZE_LOGIN_REQUEST_TTL_SECONDS,
    );
    return id;
  }

  async takeAuthorizeLoginRequest(id: string): Promise<AuthorizeLoginTransaction | null> {
    if (id === '') {
      return null;
    }
    const raw = await this.redis.getdel(`${AUTHORIZE_KEY}${id}`);
    return raw === null ? null : parseAuthorize(raw);
  }

  async saveSocialLoginRequest(transaction: SocialLoginTransaction): Promise<void> {
    await this.redis.set(
      `${SOCIAL_KEY}${transaction.state}`,
      JSON.stringify(transaction),
      'EX',
      SOCIAL_LOGIN_REQUEST_TTL_SECONDS,
    );
  }

  async takeSocialLoginRequest(state: string): Promise<SocialLoginTransaction | null> {
    if (state === '') {
      return null;
    }
    const raw = await this.redis.getdel(`${SOCIAL_KEY}${state}`);
    return raw === null ? null : parseSocial(raw);
  }
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * In-memory store with identical single-use and TTL semantics. Used by unit tests and by
 * hosts that run a single API process without Redis (never in the deployed topology).
 */
export class MemorySocialTransactionStore implements SocialTransactionStore {
  private readonly authorize = new Map<string, Entry<AuthorizeLoginTransaction>>();
  private readonly social = new Map<string, Entry<SocialLoginTransaction>>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  async createAuthorizeLoginRequest(
    input: Omit<AuthorizeLoginTransaction, 'createdAt'> & { now?: Date },
  ): Promise<string> {
    const id = randomToken(32);
    const at = input.now ?? new Date(this.now());
    this.authorize.set(id, {
      value: {
        clientId: input.clientId,
        authorizeUrl: input.authorizeUrl,
        createdAt: at.toISOString(),
      },
      expiresAt: this.now() + AUTHORIZE_LOGIN_REQUEST_TTL_SECONDS * 1000,
    });
    return id;
  }

  async takeAuthorizeLoginRequest(id: string): Promise<AuthorizeLoginTransaction | null> {
    const entry = this.authorize.get(id);
    this.authorize.delete(id);
    if (entry === undefined || entry.expiresAt <= this.now()) {
      return null;
    }
    return entry.value;
  }

  async saveSocialLoginRequest(transaction: SocialLoginTransaction): Promise<void> {
    this.social.set(transaction.state, {
      value: transaction,
      expiresAt: this.now() + SOCIAL_LOGIN_REQUEST_TTL_SECONDS * 1000,
    });
  }

  async takeSocialLoginRequest(state: string): Promise<SocialLoginTransaction | null> {
    const entry = this.social.get(state);
    this.social.delete(state);
    if (entry === undefined || entry.expiresAt <= this.now()) {
      return null;
    }
    return entry.value;
  }
}
