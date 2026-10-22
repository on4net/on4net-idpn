import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { escapeHtml, PAGE_CSP, renderPage } from './html.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
  refreshTokens,
  revokeToken,
  type FetchLike,
} from './oidc.js';
import type { IdpClientConfig } from './oidc-types.js';
import { createPkce, randomToken } from './pkce.js';
import {
  InMemoryBffStore,
  LOGIN_TRANSACTION_TTL_MS,
  SESSION_TTL_MS,
  type BffSession,
  type BffStore,
} from './store.js';

export interface BffAppOptions {
  idp: IdpClientConfig;
  store?: BffStore;
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  cookieName?: string;
  secureCookies?: boolean;
  /** Hosted Auth UI offered as a manual fallback when the BFF flow cannot complete. */
  hostedLoginUrl?: string;
  sessionTtlMs?: number;
  now?: () => number;
  logger?: boolean;
}

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
  ui_locales?: string;
  login_hint?: string;
}

const DEFAULT_COOKIE = 'bff_session';
/** Browser-bound login transaction (card #71 finding 2). */
const TX_COOKIE_NAME = 'bff_tx';
const TX_TTL_SECONDS = Math.floor(LOGIN_TRANSACTION_TTL_MS / 1000);

export function buildBffApp(options: BffAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  // The sample UI submits plain HTML forms, which post `application/x-www-form-urlencoded`.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      done(null, Object.fromEntries(new URLSearchParams(text).entries()));
    },
  );
  const store = options.store ?? new InMemoryBffStore(options.now);
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const cookieName = options.cookieName ?? DEFAULT_COOKIE;
  const now = options.now ?? Date.now;
  const sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  const hostedLoginUrl = options.hostedLoginUrl ?? `${options.idp.baseUrl.replace(/\/+$/, '')}/`;
  const secureCookies = options.secureCookies ?? options.idp.baseUrl.startsWith('https://');

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Content-Security-Policy', PAGE_CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  const readCookie = (request: FastifyRequest, name: string): string | null => {
    const header = request.headers.cookie;
    if (header === undefined) {
      return null;
    }
    for (const part of header.split(';')) {
      const separator = part.indexOf('=');
      if (separator === -1) {
        continue;
      }
      if (part.slice(0, separator).trim() === name) {
        const value = part.slice(separator + 1).trim();
        return value === '' ? null : value;
      }
    }
    return null;
  };

  const readSessionId = (request: FastifyRequest): string | null =>
    readCookie(request, cookieName);

  const cookieHeader = (name: string, value: string, maxAgeSeconds: number): string =>
    [
      `${name}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
      ...(secureCookies ? ['Secure'] : []),
    ].join('; ');

  const sessionCookie = (value: string, maxAgeSeconds: number): string =>
    cookieHeader(cookieName, value, maxAgeSeconds);

  const currentSession = async (request: FastifyRequest): Promise<BffSession | null> => {
    const id = readSessionId(request);
    return id === null ? null : store.getSession(id);
  };

  const sendPage = (
    reply: FastifyReply,
    status: number,
    title: string,
    body: string,
  ): FastifyReply =>
    reply
      .code(status)
      .header('Content-Type', 'text/html; charset=utf-8')
      .send(renderPage({ title, body }));

  /**
   * Only relative paths are echoed back, so `returnTo` cannot leave the BFF origin.
   *
   * `/\evil.example` and any value containing a backslash, whitespace or control character is
   * rejected: browsers normalise `/\` to `//`, which turns it into a protocol-relative URL
   * (card #71 finding 1).
   */
  const safeReturnTo = (value: unknown): string => {
    if (typeof value !== 'string' || value === '' || !value.startsWith('/')) {
      return '/';
    }
    const unsafe = [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === '\\' || code <= 0x20 || code === 0x7f;
    });
    if (value.startsWith('//') || unsafe) {
      return '/';
    }
    try {
      const base = 'http://bff.invalid';
      const resolved = new URL(value, base);
      const target = `${resolved.pathname}${resolved.search}${resolved.hash}`;
      // Resolving must stay on the placeholder origin, and the guard has to run on the
      // *normalised* result: `..` segments collapse `/..//evil.example` to `//evil.example`,
      // which every check on the raw input above let through (card #71 finding 1).
      if (
        resolved.origin !== base ||
        !target.startsWith('/') ||
        target.startsWith('//') ||
        target.includes('\\')
      ) {
        return '/';
      }
      return target;
    } catch {
      return '/';
    }
  };

  const signInFailed = (reply: FastifyReply, reason: string): FastifyReply =>
    reply.redirect(`/signin-failed?reason=${encodeURIComponent(reason)}`, 302);

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/login', async (request, reply) => {
    const query = request.query as { return_to?: string; ui_locales?: string; login_hint?: string };
    const pkce = createPkce();
    const transaction = {
      state: randomToken(),
      nonce: randomToken(),
      codeVerifier: pkce.verifier,
      returnTo: safeReturnTo(query.return_to),
      expiresAt: now() + LOGIN_TRANSACTION_TTL_MS,
    };
    await store.saveTransaction(transaction);

    // Bind the transaction to this browser: the callback must present the same state in the
    // cookie, so a callback URL minted elsewhere is rejected (login CSRF, card #71 finding 2).
    return reply
      .header('Set-Cookie', cookieHeader(TX_COOKIE_NAME, transaction.state, TX_TTL_SECONDS))
      .header('Cache-Control', 'no-store')
      .redirect(
        buildAuthorizeUrl(options.idp, {
          state: transaction.state,
          nonce: transaction.nonce,
          codeChallenge: pkce.challenge,
          ...(query.ui_locales === undefined ? {} : { uiLocales: query.ui_locales }),
          ...(query.login_hint === undefined ? {} : { loginHint: query.login_hint }),
        }),
        302,
      );
  });

  app.get('/auth/callback', async (request, reply) => {
    const query = request.query as CallbackQuery;

    if (query.error !== undefined) {
      return signInFailed(reply, query.error);
    }
    if (query.state === undefined || query.state === '' || query.code === undefined) {
      return signInFailed(reply, 'invalid_request');
    }

    if (readCookie(request, TX_COOKIE_NAME) !== query.state) {
      // The browser that started the flow must be the one that finishes it.
      return signInFailed(reply, 'invalid_state');
    }

    const transaction = await store.takeTransaction(query.state);
    if (transaction === null) {
      // Unknown, replayed or expired `state`: never exchange a code for it.
      return signInFailed(reply, 'invalid_state');
    }

    const result = await exchangeCode(fetchImpl, options.idp, {
      code: query.code,
      codeVerifier: transaction.codeVerifier,
    });
    if (!result.ok) {
      request.log.warn(
        { idpError: result.error, status: result.status ?? null },
        'authorization code exchange failed',
      );
      return signInFailed(reply, `token_exchange_failed:${result.error}`);
    }

    const session: BffSession = {
      id: randomToken(),
      tokens: result.value,
      expiresAt: now() + Math.min(sessionTtlMs, result.value.expires_in * 1000),
    };
    await store.createSession(session);

    return reply
      .header('Set-Cookie', [
        sessionCookie(session.id, Math.max(1, Math.floor(sessionTtlMs / 1000))),
        // The transaction is consumed: drop the binding cookie in the same response.
        cookieHeader(TX_COOKIE_NAME, '', 0),
      ])
      .redirect(transaction.returnTo, 302);
  });

  /** Calls userinfo and refreshes once on `401`, keeping the refreshed tokens server-side. */
  const loadProfile = async (
    session: BffSession,
  ): Promise<{ session: BffSession; claims: Record<string, unknown> } | null> => {
    const first = await fetchUserInfo(fetchImpl, options.idp, session.tokens.access_token);
    if (first.ok) {
      return { session, claims: first.claims };
    }
    if (first.status !== 401 || session.tokens.refresh_token === undefined) {
      return null;
    }
    const refreshed = await refreshTokens(fetchImpl, options.idp, session.tokens.refresh_token);
    if (!refreshed.ok) {
      return null;
    }
    const updated: BffSession = {
      ...session,
      tokens: refreshed.value,
      expiresAt: now() + Math.min(sessionTtlMs, refreshed.value.expires_in * 1000),
    };
    await store.updateSession(session.id, updated);
    const retry = await fetchUserInfo(fetchImpl, options.idp, updated.tokens.access_token);
    return retry.ok ? { session: updated, claims: retry.claims } : null;
  };

  app.get('/', async (request, reply) => {
    const session = await currentSession(request);
    if (session === null) {
      return reply.redirect('/login', 302);
    }
    const profile = await loadProfile(session);
    if (profile === null) {
      await store.deleteSession(session.id);
      return reply
        .header('Set-Cookie', sessionCookie('', 0))
        .redirect('/signin-failed?reason=session_expired', 302);
    }

    const rows = Object.entries(profile.claims)
      .map(
        ([key, value]) =>
          `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(
            typeof value === 'object' ? JSON.stringify(value) : value,
          )}</dd>`,
      )
      .join('');

    return sendPage(
      reply,
      200,
      'Signed in',
      `<h1 data-testid="signed-in">Signed in</h1>
      <dl data-testid="claims">${rows}</dl>
      <form method="post" action="/refresh">
        <button type="submit" data-testid="refresh">Refresh tokens</button>
      </form>
      <form method="post" action="/logout">
        <button type="submit" data-testid="logout">Sign out</button>
      </form>`,
    );
  });

  app.get('/api/session', async (request, reply) => {
    const session = await currentSession(request);
    if (session === null) {
      return reply.send({ authenticated: false });
    }
    const profile = await loadProfile(session);
    if (profile === null) {
      return reply.send({ authenticated: false });
    }
    return reply.send({
      authenticated: true,
      expiresAt: new Date(profile.session.expiresAt).toISOString(),
      claims: profile.claims,
    });
  });

  app.post('/refresh', async (request, reply) => {
    const session = await currentSession(request);
    if (session === null) {
      return reply.redirect('/login', 302);
    }
    if (session.tokens.refresh_token === undefined) {
      return signInFailed(reply, 'no_refresh_token');
    }
    const refreshed = await refreshTokens(fetchImpl, options.idp, session.tokens.refresh_token);
    if (!refreshed.ok) {
      await store.deleteSession(session.id);
      return reply
        .header('Set-Cookie', sessionCookie('', 0))
        .redirect('/signin-failed?reason=refresh_failed', 302);
    }
    await store.updateSession(session.id, {
      ...session,
      tokens: refreshed.value,
      expiresAt: now() + Math.min(sessionTtlMs, refreshed.value.expires_in * 1000),
    });
    return reply.redirect('/', 302);
  });

  app.post('/logout', async (request, reply) => {
    const session = await currentSession(request);
    if (session !== null) {
      if (session.tokens.refresh_token !== undefined) {
        await revokeToken(fetchImpl, options.idp, session.tokens.refresh_token);
      }
      await store.deleteSession(session.id);
    }
    return reply.header('Set-Cookie', sessionCookie('', 0)).redirect('/signed-out', 302);
  });

  app.get('/signed-out', async (_request, reply) =>
    sendPage(
      reply,
      200,
      'Signed out',
      `<h1 data-testid="signed-out">Signed out</h1>
      <p>The platform session and the tokens stored with it were discarded.</p>
      <p><a href="/login">Sign in again</a></p>`,
    ),
  );

  app.get('/signin-failed', async (request, reply) => {
    const reason = (request.query as { reason?: string }).reason ?? 'unknown';
    return sendPage(
      reply,
      400,
      'Sign-in failed',
      `<h1 data-testid="signin-failed">Sign-in failed</h1>
      <p class="notice" data-testid="reason">${escapeHtml(reason)}</p>
      <p><a href="/login">Try again</a></p>
      <p>
        <a data-testid="hosted-fallback" href="${escapeHtml(hostedLoginUrl)}">
          Continue to the Hosted sign-in page
        </a>
      </p>`,
    );
  });

  return app;
}
