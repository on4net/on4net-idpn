/** Options for the atomic session + user-index write. */
export interface IndexedSessionWrite {
  key: string;
  value: string;
  /** TTL of the session record itself. */
  ttlSeconds: number;
  indexKey: string;
  member: string;
  /** TTL of the user index set, normally the absolute session lifetime. */
  indexTtlSeconds: number;
}

/** Minimal key/value surface the session store needs (Redis in production, Map in tests). */
export interface SessionCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Adds a member to a set and refreshes the set TTL. */
  setAdd(key: string, member: string, ttlSeconds: number): Promise<void>;
  setRemove(key: string, member: string): Promise<void>;
  setMembers(key: string): Promise<string[]>;
  /**
   * Writes the session record and adds it to the user index in one atomic step, so a crash or
   * a failed second call can never produce a live session that `revokeAllForUser` does not
   * know about (card #70 finding 5b). Optional because an in-memory cache is single-threaded
   * and cannot interleave.
   */
  setWithIndex?(write: IndexedSessionWrite): Promise<void>;
}
