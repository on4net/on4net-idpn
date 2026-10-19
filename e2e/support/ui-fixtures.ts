import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Deterministic fixtures for the UI accessibility and visual suites.
 *
 * Every IdP call is answered at the Playwright route layer: the suites never need a
 * database, Redis, a social provider or real credentials. Timestamps are fixed so
 * screenshots do not depend on the clock; the runner pins the timezone to UTC.
 */

export type LoginBehaviour = 'success' | 'mfa' | 'invalid';

export interface UiFixtureOptions {
  /** Password-step outcome. `mfa` renders the second-factor screen. */
  login?: LoginBehaviour;
  locale?: 'fa-IR' | 'en-US';
  /** Per-client overrides returned by `…/translations/bundle` (base keys only). */
  translations?: Record<string, string>;
}

const NOW = '2026-10-19T09:00:00.000Z';

const member = (overrides: Record<string, unknown> = {}) => ({
  membershipId: 'm1',
  userId: 'u1',
  email: 'negar@example.com',
  username: 'negar',
  displayName: 'نگار کریمی',
  userStatus: 'active',
  status: 'active',
  attributes: {},
  roleKeys: ['app-a:member'],
  invitedAt: null,
  joinedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const adminUser = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-1',
  username: 'ali',
  email: 'ali@example.com',
  displayName: 'Ali Rezaei',
  phone: null,
  locale: 'fa-IR',
  status: 'active',
  emailVerified: true,
  mustChangePassword: false,
  lockedUntil: null,
  lastLoginAt: '2026-10-18T08:00:00.000Z',
  createdAt: '2026-10-17T08:00:00.000Z',
  updatedAt: '2026-10-18T08:00:00.000Z',
  ...overrides,
});

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/**
 * Answers the documented IdP endpoints with stable data. Unknown `/api/v1/**` paths get a
 * 404 problem response so a missing fixture fails loudly instead of hanging the UI.
 */
export async function installUiFixtures(page: Page, options: UiFixtureOptions = {}): Promise<void> {
  const login = options.login ?? 'success';
  const locale = options.locale ?? 'fa-IR';
  const translations = options.translations ?? {};

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path.endsWith('/public-config')) {
      await route.fulfill(
        json({
          locale,
          locales: {
            default: locale,
            supported: ['fa-IR', 'en-US'],
            dir: { 'fa-IR': 'rtl', 'en-US': 'ltr' },
          },
          translationsUrl: '/api/v1/clients/admin-panel/translations/bundle',
          theme: { primary: '#0057b8', radius: '8px' },
          loginContexts: [{ key: 'default', methods: ['password'] }],
          socialProviders: [],
        }),
      );
      return;
    }

    if (path.endsWith('/translations/bundle')) {
      const requested = url.searchParams.get('locale') ?? locale;
      await route.fulfill(
        json({
          locale: requested,
          dir: requested === 'en-US' ? 'ltr' : 'rtl',
          version: NOW,
          messages: translations,
        }),
      );
      return;
    }

    if (path === '/api/v1/login' && request.method() === 'POST') {
      if (login === 'mfa') {
        await route.fulfill(
          json({ mfa: 'challenge', challengeToken: 'challenge-1', methods: ['totp'] }),
        );
        return;
      }
      if (login === 'invalid') {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'invalid_credentials', message: 'invalid' }),
        });
        return;
      }
      await route.fulfill(
        json({ ok: true, redirectTo: '/oauth2/authorize?client_id=admin-panel' }),
      );
      return;
    }

    if (path === '/api/v1/login/mfa/verify') {
      await route.fulfill(json({ redirectTo: '/oauth2/authorize?client_id=admin-panel' }));
      return;
    }

    if (path === '/api/v1/account/profile') {
      await route.fulfill(
        json({
          id: 'u1',
          username: 'negar',
          email: 'negar@example.com',
          displayName: 'نگار کریمی',
          phone: null,
          avatarUrl: null,
          locale,
          status: 'active',
          emailVerified: true,
          mustChangePassword: false,
          createdAt: '2026-10-01T09:00:00.000Z',
          passwordChangedAt: '2026-10-10T09:00:00.000Z',
        }),
      );
      return;
    }

    if (path === '/api/v1/account/sessions') {
      await route.fulfill(
        json({
          items: [
            {
              id: 'session-1',
              clientId: 'app-a',
              userAgent: 'Playwright',
              ip: '127.0.0.1',
              createdAt: '2026-10-19T08:00:00.000Z',
              lastSeenAt: '2026-10-19T08:30:00.000Z',
              current: true,
            },
          ],
          page: 1,
          limit: 25,
          total: 1,
        }),
      );
      return;
    }

    if (path === '/api/v1/account/mfa') {
      await route.fulfill(json({ enabled: false, factors: [] }));
      return;
    }

    if (path === '/api/v1/clients/app-a/members') {
      await route.fulfill(
        json({
          items: [
            member(),
            member({
              membershipId: 'm2',
              userId: 'u2',
              email: 'sara@example.com',
              username: 'sara',
              displayName: 'Sara Ahmadi',
              userStatus: 'invited',
              status: 'invited',
              roleKeys: [],
            }),
          ],
          page: 1,
          limit: 10,
          total: 2,
        }),
      );
      return;
    }

    if (path === '/api/v1/roles') {
      await route.fulfill(
        json({
          items: [
            { id: 'r1', key: 'app-a:member', name: 'عضو', description: null, isDefault: true },
            { id: 'r2', key: 'app-a:admin', name: 'مدیر', description: null, isDefault: false },
          ],
        }),
      );
      return;
    }

    if (path === '/api/v1/me') {
      await route.fulfill(
        json({ id: 'admin-1', clientId: 'admin-panel', scopes: ['idp.admin'], permissions: [] }),
      );
      return;
    }

    if (path === '/api/v1/users') {
      await route.fulfill(
        json({
          items: [
            adminUser(),
            adminUser({
              id: 'user-2',
              username: 'maryam',
              email: 'maryam@example.com',
              displayName: 'Maryam Hosseini',
              status: 'locked',
            }),
            adminUser({
              id: 'user-3',
              username: 'reza',
              email: 'reza@example.com',
              displayName: 'Reza Karimi',
              status: 'disabled',
            }),
          ],
          page: 1,
          limit: 25,
          total: 3,
        }),
      );
      return;
    }

    if (path === '/api/v1/sessions') {
      await route.fulfill(
        json({
          items: [
            {
              id: 'session-1',
              userId: 'user-1',
              clientId: 'app-a',
              status: 'active',
              createdAt: '2026-10-19T08:00:00.000Z',
              lastSeenAt: '2026-10-19T08:30:00.000Z',
              idleExpiresAt: '2026-10-19T09:00:00.000Z',
              absoluteExpiresAt: '2026-10-19T20:00:00.000Z',
              ip: '127.0.0.1',
              userAgent: 'Playwright',
              amr: ['pwd'],
              acr: 'urn:on4net:acr:pwd',
              revokedAt: null,
              revokeReason: null,
            },
            {
              id: 'session-2',
              userId: 'user-2',
              clientId: 'admin-panel',
              status: 'revoked',
              createdAt: '2026-10-18T08:00:00.000Z',
              lastSeenAt: '2026-10-18T08:10:00.000Z',
              idleExpiresAt: '2026-10-18T08:40:00.000Z',
              absoluteExpiresAt: '2026-10-18T20:00:00.000Z',
              ip: '127.0.0.1',
              userAgent: 'Playwright',
              amr: ['pwd'],
              acr: 'urn:on4net:acr:pwd',
              revokedAt: '2026-10-18T09:00:00.000Z',
              revokeReason: 'logout',
            },
          ],
          page: 1,
          limit: 25,
          total: 2,
        }),
      );
      return;
    }

    if (path.startsWith('/api/v1/audit-events/export')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/csv',
        body: 'occurredAt,action,result\n2026-10-19T09:00:00.000Z,user.login,success\n',
      });
      return;
    }

    if (path === '/api/v1/audit-events') {
      await route.fulfill(
        json({
          items: [
            {
              id: 'evt-1',
              occurredAt: '2026-10-19T09:00:00.000Z',
              actorType: 'user',
              actorId: 'user-1',
              action: 'user.login',
              targetType: 'session',
              targetId: 'session-1',
              clientId: 'app-a',
              ip: '127.0.0.1',
              userAgent: 'Playwright',
              result: 'success',
              metadata: {},
            },
            {
              id: 'evt-2',
              occurredAt: '2026-10-19T08:45:00.000Z',
              actorType: 'admin',
              actorId: 'admin-1',
              action: 'user.role.changed',
              targetType: 'user',
              targetId: 'user-2',
              clientId: 'app-a',
              ip: '127.0.0.1',
              userAgent: 'Playwright',
              result: 'failure',
              metadata: {},
            },
          ],
          page: 1,
          limit: 25,
          total: 2,
        }),
      );
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/problem+json',
      body: JSON.stringify({ title: 'fixture missing', detail: `${request.method()} ${path}` }),
    });
  });
}

/** Human-readable failure message for CI logs (axe nodes include selectors and snippets). */
export function formatViolations(
  violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations'],
): string {
  return violations
    .map((violation) => {
      const nodes = violation.nodes
        .map(
          (node) =>
            `    - ${node.target.join(' ')} :: ${node.html.slice(0, 160)}\n      ${
              node.failureSummary?.replace(/\s+/g, ' ') ?? ''
            }`,
        )
        .join('\n');
      return `${violation.id} [${violation.impact}] ${violation.help}\n${nodes}`;
    })
    .join('\n');
}

/** Runs axe on the current page; only Critical/Serious findings fail the gate. */
export async function expectNoBlockingViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  );
  expect(blocking, formatViolations(blocking)).toEqual([]);
}
