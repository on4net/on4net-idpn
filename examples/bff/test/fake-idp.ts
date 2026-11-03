import type { FetchLike } from '../src/oidc.js';
import { s256Challenge } from '../src/pkce.js';

export interface FakeIdpOptions {
  clientId: string;
  clientSecret: string;
  expiresIn?: number;
}

interface CodeRecord {
  challenge: string;
  redirectUri: string;
  nonce: string;
  used: boolean;
}

interface RefreshRecord {
  rotated: boolean;
  revoked: boolean;
}

export interface FakeIdp {
  fetchImpl: FetchLike;
  calls: { path: string; body: Record<string, string> }[];
  tokenCallCount(): number;
  issueCode(input: { challenge: string; redirectUri: string; nonce: string }): string;
  expireAccessTokens(): void;
  revokeRefreshToken(token: string): void;
  refreshTokenState(token: string): RefreshRecord | undefined;
  lastRefreshToken(): string | undefined;
}

/**
 * Minimal in-memory IdP for the sample app's tests: it validates PKCE, rotates refresh
 * tokens, rejects reused codes and reports revocation — enough to prove the BFF keeps its
 * side of the contract without a database.
 */
export function createFakeIdp(options: FakeIdpOptions): FakeIdp {
  const codes = new Map<string, CodeRecord>();
  const accessTokens = new Map<string, string[]>();
  const refreshTokens = new Map<string, RefreshRecord>();
  const calls: { path: string; body: Record<string, string> }[] = [];
  let counter = 0;

  const expectedAuth = `Basic ${Buffer.from(
    `${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`,
    'utf8',
  ).toString('base64')}`;

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const mint = (scope: string) => {
    counter += 1;
    const accessToken = `at-${counter}`;
    const refreshToken = `rt-${counter}`;
    accessTokens.set(accessToken, scope.split(' '));
    refreshTokens.set(refreshToken, { rotated: false, revoked: false });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: options.expiresIn ?? 300,
      refresh_token: refreshToken,
      id_token: `idt-${counter}`,
      scope,
    };
  };

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    const entries = Object.fromEntries(body.entries());
    calls.push({ path: url.pathname, body: entries });

    if (url.pathname === '/oauth2/token') {
      const authorization = (init?.headers as Record<string, string> | undefined)?.[
        'Authorization'
      ];
      if (authorization !== expectedAuth) {
        return json(401, { error: 'invalid_client' });
      }
      const grant = entries['grant_type'];
      if (grant === 'authorization_code') {
        const record = codes.get(entries['code'] ?? '');
        if (record === undefined || record.used) {
          return json(400, { error: 'invalid_grant' });
        }
        const verifier = entries['code_verifier'] ?? '';
        if (verifier === '' || s256Challenge(verifier) !== record.challenge) {
          return json(400, { error: 'invalid_grant', error_description: 'pkce' });
        }
        record.used = true;
        return json(200, mint('openid profile email'));
      }
      if (grant === 'refresh_token') {
        const record = refreshTokens.get(entries['refresh_token'] ?? '');
        if (record === undefined || record.revoked || record.rotated) {
          return json(400, { error: 'invalid_grant' });
        }
        record.rotated = true;
        return json(200, mint('openid profile email'));
      }
      return json(400, { error: 'unsupported_grant_type' });
    }

    if (url.pathname === '/oauth2/userinfo') {
      const authorization = (init?.headers as Record<string, string> | undefined)?.[
        'Authorization'
      ];
      const token = authorization?.replace(/^Bearer\s+/i, '') ?? '';
      const scopes = accessTokens.get(token);
      if (scopes === undefined) {
        return json(401, { error: 'invalid_token' });
      }
      return json(200, {
        sub: 'user-1',
        email: 'sara@example.com',
        name: 'Sara',
        ...(scopes.includes('email') ? { email_verified: true } : {}),
      });
    }

    if (url.pathname === '/oauth2/revoke') {
      const record = refreshTokens.get(entries['token'] ?? '');
      if (record !== undefined) {
        record.revoked = true;
      }
      return new Response(null, { status: 200 });
    }

    return json(404, { error: 'not_found' });
  };

  return {
    fetchImpl,
    calls,
    tokenCallCount: () => calls.filter((call) => call.path === '/oauth2/token').length,
    issueCode: ({ challenge, redirectUri, nonce }) => {
      counter += 1;
      const code = `code-${counter}`;
      codes.set(code, { challenge, redirectUri, nonce, used: false });
      return code;
    },
    expireAccessTokens: () => accessTokens.clear(),
    revokeRefreshToken: (token) => {
      const record = refreshTokens.get(token);
      if (record !== undefined) {
        record.revoked = true;
      }
    },
    refreshTokenState: (token) => refreshTokens.get(token),
    lastRefreshToken: () => {
      const issued = [...refreshTokens.keys()];
      return issued.at(-1);
    },
  };
}
