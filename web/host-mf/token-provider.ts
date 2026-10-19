/**
 * Optional SPA-mode token holder (docs/mfe-sdk.md 6.2).
 *
 * Only hosts that explicitly configure `mode: 'spa'` need this. The token lives in a
 * closure: it is never written to `localStorage`, `sessionStorage`, a cookie, the URL or
 * the DOM, so a reload or a second tab cannot recover it. The host's OIDC client calls
 * `setAccessToken` after a silent renew and `clear` on logout.
 */
export interface InMemoryTokenProvider {
  getAccessToken(): string | null;
  setAccessToken(token: string | null): void;
  clear(): void;
}

export function createInMemoryTokenProvider(
  initialToken: string | null = null,
): InMemoryTokenProvider {
  let token = initialToken;

  return {
    getAccessToken: () => token,
    setAccessToken: (next) => {
      token = next === null || next === '' ? null : next;
    },
    clear: () => {
      token = null;
    },
  };
}
