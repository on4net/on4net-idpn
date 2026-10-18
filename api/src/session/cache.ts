/** Minimal key/value surface the session store needs (Redis in production, Map in tests). */
export interface SessionCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Adds a member to a set and refreshes the set TTL. */
  setAdd(key: string, member: string, ttlSeconds: number): Promise<void>;
  setRemove(key: string, member: string): Promise<void>;
  setMembers(key: string): Promise<string[]>;
}
