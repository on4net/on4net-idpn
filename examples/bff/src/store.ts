import type { TokenSet } from './oidc-types.js';

/**
 * A pending authorization request. `state`, `nonce` and the PKCE verifier live here — in the
 * server-side session — and never in a browser-readable cookie or in the redirect URL.
 */
export interface LoginTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
}

/** The platform session: the browser only ever holds the opaque session id. */
export interface BffSession {
  id: string;
  tokens: TokenSet;
  /** Epoch milliseconds; derived from `expires_in` at the time of issue. */
  expiresAt: number;
}

export interface BffStore {
  saveTransaction(transaction: LoginTransaction): Promise<void>;
  /** Reads and deletes the transaction, so a `state` value is single-use. */
  takeTransaction(state: string): Promise<LoginTransaction | null>;
  createSession(session: BffSession): Promise<void>;
  getSession(id: string): Promise<BffSession | null>;
  updateSession(id: string, session: BffSession): Promise<void>;
  deleteSession(id: string): Promise<void>;
}

export const LOGIN_TRANSACTION_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * In-memory store for the sample app. A real platform stores transactions and sessions in
 * Redis or PostgreSQL so that several instances share them; the interface is the seam.
 */
export class InMemoryBffStore implements BffStore {
  private readonly transactions = new Map<string, LoginTransaction>();
  private readonly sessions = new Map<string, BffSession>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  saveTransaction(transaction: LoginTransaction): Promise<void> {
    this.transactions.set(transaction.state, transaction);
    return Promise.resolve();
  }

  takeTransaction(state: string): Promise<LoginTransaction | null> {
    const transaction = this.transactions.get(state);
    if (transaction === undefined) {
      return Promise.resolve(null);
    }
    this.transactions.delete(state);
    return Promise.resolve(transaction.expiresAt <= this.now() ? null : transaction);
  }

  createSession(session: BffSession): Promise<void> {
    this.sessions.set(session.id, session);
    return Promise.resolve();
  }

  getSession(id: string): Promise<BffSession | null> {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return Promise.resolve(null);
    }
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return Promise.resolve(null);
    }
    return Promise.resolve(session);
  }

  updateSession(id: string, session: BffSession): Promise<void> {
    this.sessions.set(id, session);
    return Promise.resolve();
  }

  deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
    return Promise.resolve();
  }

  /** Number of retained transactions; used by tests and diagnostics. */
  get transactionCount(): number {
    return this.transactions.size;
  }

  /** Number of retained sessions; used by tests and diagnostics. */
  get sessionCount(): number {
    return this.sessions.size;
  }
}
