import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaAccountProfileRepository } from '../src/account/prisma-account-repository.js';
import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { createPrismaAdminSessionRepository } from '../src/admin/sessions/prisma-session-repository.js';
import { createPrismaPasswordStore } from '../src/audit/prisma-audit.js';
import { createPrismaContextSwitchRepository } from '../src/login/context-switch.js';
import { createPrismaMfaRepository } from '../src/mfa/prisma-repository.js';
import { s256Challenge } from '../src/oidc/authorization-code.js';
import {
  createAuthorizeAuthenticationRequirement,
  createAuthorizeMembershipStatus,
} from '../src/oidc/authorize-enforcement.js';
import { createPrismaClientRepository } from '../src/oidc/prisma-client-repository.js';
import { createPrismaCodeRepository } from '../src/oidc/prisma-code-repository.js';
import { createPrismaRefreshTokenRepository } from '../src/oidc/prisma-refresh-repository.js';
import { createPrismaUserRepository } from '../src/oidc/prisma-user-repository.js';
import { buildServer } from '../src/server.js';
import { RedisSessionCache } from '../src/session/redis-cache.js';
import { RedisSessionStore } from '../src/session/store.js';
import type { IdpSession } from '../src/session/types.js';
import { startPhase4Infra, type Phase4Infra } from './phase4-harness.js';

/**
 * Context-aware sessions, context switching and step-up
 * (`docs/login-contexts.md` 3.4, 4.1, 6-9, CTX-007).
 *
 * Every negative case has a positive control built from the same fixtures: one user is a
 * member of several contexts, another only of one, another has a suspended membership, so a
 * refusal can only come from the rule under test.
 */

const issuer = 'http://127.0.0.1:3460';
const adminClientId = 'admin-panel';
const REDIRECT_URI = 'https://app-a.example.com/callback';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const MFA_ACR = 'urn:on4net:acr:mfa';
const PWD_ACR = 'urn:on4net:acr:pwd';
const AUTH_SCHEME = 'Bearer';

let infra: Phase4Infra;
let store: RedisSessionStore;
let app: ReturnType<typeof buildServer>;
let prisma: Phase4Infra['prisma'];

const ids = {
  appA: '',
  appB: '',
  admin: '',
  contexts: {
    customerAdmin: '',
    customerTeam: '',
    ledgerAdmin: '',
    mfaRequired: '',
    disabled: '',
    partnerPortal: '',
  },
  users: {
    multi: '',
    teamOnly: '',
    suspended: '',
    outsider: '',
    revoker: '',
    admin: '',
  },
};

interface CreatedSession {
  session: IdpSession;
  sid: string;
}

const cookieOf = (sid: string): string => `idpn_session=${sid}`;
const sameOrigin = { Origin: issuer };

async function makeSession(
  userId: string,
  options: {
    loginContext?: string;
    clientId?: string;
    amr?: string[];
    acr?: string;
    authTime?: Date;
  } = {},
): Promise<CreatedSession> {
  const clientId = options.clientId ?? 'app-a';
  const session = await store.create({
    userId,
    clientId,
    ...(options.loginContext === undefined ? {} : { loginContext: options.loginContext }),
    amr: options.amr ?? ['pwd'],
    acr: options.acr ?? PWD_ACR,
    authTime: options.authTime ?? new Date(),
    ip: '10.0.0.1',
    userAgent: 'vitest-agent',
  });
  await prisma.session.create({
    data: {
      id: session.sid,
      userId,
      clientId: clientId === 'app-a' ? ids.appA : clientId === 'app-b' ? ids.appB : null,
      loginContext: session.loginContext ?? null,
      createdAt: new Date(session.createdAt),
      lastSeenAt: new Date(session.lastSeenAt),
      idleExpiresAt: new Date(session.idleExpiresAt),
      absoluteExpiresAt: new Date(session.absoluteExpiresAt),
      ip: session.ip ?? null,
      userAgent: session.userAgent ?? null,
      amr: session.amr,
      acr: session.acr,
    },
  });
  return { session, sid: session.sid };
}

const accountSessions = (sid: string) =>
  request(app.server).get('/api/v1/account/sessions').set('Cookie', cookieOf(sid)).set(sameOrigin);

const switchContext = (sid: string, loginContext: string) =>
  request(app.server)
    .post('/api/v1/account/sessions/switch-context')
    .set('Cookie', cookieOf(sid))
    .set(sameOrigin)
    .send({ loginContext });

async function adminToken(): Promise<string> {
  const token = await infra.keys.signAccessToken(
    { scope: 'openid idp.admin', client_id: adminClientId },
    { issuer, audience: adminClientId, subject: ids.users.admin, expiresInSeconds: 300 },
  );
  return `${AUTH_SCHEME} ${token}`;
}

const authorize = (sid: string | undefined, params: { loginContext?: string; prompt?: string }) => {
  const pending = request(app.server)
    .get('/oauth2/authorize')
    .query({
      response_type: 'code',
      client_id: 'app-a',
      redirect_uri: REDIRECT_URI,
      scope: 'openid',
      state: 'state-1',
      nonce: 'nonce-1',
      code_challenge: s256Challenge(verifier),
      code_challenge_method: 'S256',
      ...(params.loginContext === undefined ? {} : { login_context: params.loginContext }),
      ...(params.prompt === undefined ? {} : { prompt: params.prompt }),
    });
  if (sid !== undefined) {
    pending.set('Cookie', cookieOf(sid));
  }
  return pending;
};

const locationOf = async (response: request.Response): Promise<URL> => {
  expect(response.status).toBe(302);
  return new URL(response.headers.location as string);
};

beforeAll(async () => {
  infra = await startPhase4Infra('idpn_ctx_sessions');
  prisma = infra.prisma;
  store = new RedisSessionStore({
    cache: new RedisSessionCache(infra.redis),
    policy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600, maxConcurrentSessions: 0 },
  });

  const tenantId = infra.tenantId;
  const createClient = async (clientId: string, redirectUris: string[]) => {
    const row = await prisma.client.create({
      data: {
        clientId,
        name: clientId,
        type: 'spa',
        redirectUris,
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        scopes: ['openid', 'profile', 'idp.client-admin'],
        tenantId,
      },
      select: { id: true },
    });
    return row.id;
  };
  ids.appA = await createClient('app-a', [REDIRECT_URI]);
  ids.appB = await createClient('app-b', ['https://app-b.example.com/callback']);
  await prisma.client.create({
    data: {
      clientId: adminClientId,
      name: adminClientId,
      type: 'spa',
      redirectUris: ['https://admin.example.com/cb'],
      postLogoutRedirectUris: [],
      allowedOrigins: [],
      scopes: ['openid', 'idp.admin'],
      tenantId,
    },
    select: { id: true },
  });
  const createContext = async (
    clientUuid: string,
    key: string,
    options: {
      mfaPolicy?: 'optional' | 'required_admins' | 'required_all';
      stepUpRequired?: boolean;
      status?: 'active' | 'disabled';
      isDefault?: boolean;
    } = {},
  ) =>
    prisma.clientLoginContext.create({
      data: {
        clientId: clientUuid,
        key,
        name: key,
        allowedRoles: [],
        defaultRoles: [],
        loginMethods: ['password'],
        mfaPolicy: options.mfaPolicy ?? 'optional',
        status: options.status ?? 'active',
        isDefault: options.isDefault ?? false,
        stepUpRequired: options.stepUpRequired ?? false,
        sessionIdleTtl: 1800,
        sessionAbsoluteTtl: 28_800,
      },
      select: { id: true },
    });

  ids.contexts.customerAdmin = (
    await createContext(ids.appA, 'customer-admin', { isDefault: true })
  ).id;
  ids.contexts.customerTeam = (await createContext(ids.appA, 'customer-team')).id;
  ids.contexts.ledgerAdmin = (
    await createContext(ids.appA, 'ledger-admin', { stepUpRequired: true })
  ).id;
  ids.contexts.mfaRequired = (
    await createContext(ids.appA, 'mfa-required', { mfaPolicy: 'required_all' })
  ).id;
  ids.contexts.disabled = (
    await createContext(ids.appA, 'disabled-context', { status: 'disabled' })
  ).id;
  ids.contexts.partnerPortal = (await createContext(ids.appB, 'partner-portal')).id;
  await prisma.client.update({
    where: { id: ids.appA },
    data: { defaultLoginContextKey: 'customer-admin' },
  });

  const createUser = async (username: string) =>
    (
      await prisma.user.create({
        data: {
          tenantId,
          username,
          email: `${username}@example.com`,
          displayName: username,
          status: 'active',
        },
        select: { id: true },
      })
    ).id;

  ids.users.multi = await createUser('ctx-multi');
  ids.users.teamOnly = await createUser('ctx-team-only');
  ids.users.suspended = await createUser('ctx-suspended');
  ids.users.outsider = await createUser('ctx-outsider');
  ids.users.revoker = await createUser('ctx-revoker');
  ids.users.admin = await createUser('ctx-admin');

  const membership = (contextId: string, userId: string, status: 'active' | 'suspended') =>
    prisma.clientMembership.create({
      data: {
        clientId: ids.appA,
        userId,
        loginContextId: contextId,
        status,
        attributes: {},
        joinedAt: new Date(),
      },
    });

  await membership(ids.contexts.customerAdmin, ids.users.multi, 'active');
  await membership(ids.contexts.customerTeam, ids.users.multi, 'active');
  await membership(ids.contexts.ledgerAdmin, ids.users.multi, 'active');
  await membership(ids.contexts.mfaRequired, ids.users.multi, 'active');
  await membership(ids.contexts.customerTeam, ids.users.teamOnly, 'active');
  await membership(ids.contexts.customerAdmin, ids.users.revoker, 'active');
  await membership(ids.contexts.customerTeam, ids.users.revoker, 'active');
  await membership(ids.contexts.customerAdmin, ids.users.suspended, 'suspended');
  await membership(ids.contexts.customerTeam, ids.users.suspended, 'active');

  // Global admin that may read sessions (`docs/api.md` 3.7).
  const permission = await prisma.permission.create({
    data: { key: 'idp:session:read', description: 'read sessions', clientId: null },
  });
  const role = await prisma.role.create({
    data: {
      key: 'ctx-session-reader',
      name: 'session reader',
      description: 'session reader',
      clientId: null,
      rolePermissions: { create: [{ permissionId: permission.id }] },
    },
  });
  await prisma.assignment.create({
    data: {
      subjectType: 'user',
      subjectId: ids.users.admin,
      roleId: role.id,
      scopeType: 'global',
      assignedBy: ids.users.admin,
    },
  });

  const permissions = createPrismaPermissionReader(prisma);
  const audit = createPrismaAdminAudit(prisma);
  const clients = createPrismaClientRepository(prisma);
  const users = createPrismaUserRepository(prisma);
  const sessionRepository = createPrismaAdminSessionRepository(prisma);
  const mfaRepository = createPrismaMfaRepository(prisma, { permissions });

  app = buildServer({
    issuer,
    keys: infra.keys,
    token: {
      clients,
      codes: createPrismaCodeRepository(prisma),
      refreshTokens: createPrismaRefreshTokenRepository(prisma),
      users,
      sessions: store,
    },
    authorize: {
      clients,
      membershipStatus: createAuthorizeMembershipStatus(prisma),
      authenticationRequirement: createAuthorizeAuthenticationRequirement(mfaRepository),
      audit,
      persistContextSwitch: async (sid, loginContext) => {
        await sessionRepository.updateLoginContext?.(sid, loginContext);
      },
    },
    adminSessions: {
      adminClientId,
      permissions,
      repository: sessionRepository,
      revoker: store,
      audit,
    },
    account: {
      sessions: store,
      repository: sessionRepository,
      profiles: createPrismaAccountProfileRepository(prisma),
      passwords: createPrismaPasswordStore(prisma),
      audit,
      contextSwitch: {
        repository: createPrismaContextSwitchRepository(prisma),
        isAdmin: (userId, clientId) => mfaRepository.isAdmin(userId, clientId),
      },
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await infra?.close();
});

describe('context-aware sessions', () => {
  it('records one independent session per context of the same client', async () => {
    const admin = await makeSession(ids.users.multi, { loginContext: 'customer-admin' });
    const team = await makeSession(ids.users.multi, { loginContext: 'customer-team' });
    const unbound = await makeSession(ids.users.multi, {});

    expect(team.sid).not.toBe(admin.sid);
    const listed = await accountSessions(admin.sid);
    expect(listed.status).toBe(200);
    const items = (listed.body.items as { id: string; loginContext: string | null }[]).filter(
      (item) => [admin.sid, team.sid, unbound.sid].includes(item.id),
    );
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.loginContext).sort()).toEqual(
      ['customer-admin', 'customer-team', null].sort(),
    );

    const stored = await prisma.session.findUniqueOrThrow({ where: { id: team.sid } });
    expect(stored.loginContext).toBe('customer-team');
  });

  it('filters the admin session listing by login context', async () => {
    const admin = await makeSession(ids.users.multi, { loginContext: 'customer-admin' });
    const team = await makeSession(ids.users.multi, { loginContext: 'customer-team' });
    const token = await adminToken();

    const filtered = await request(app.server)
      .get(`/api/v1/sessions?userId=${ids.users.multi}&loginContext=customer-team`)
      .set('Authorization', token);

    expect(filtered.status).toBe(200);
    const idsReturned = (filtered.body.items as { id: string; loginContext: string }[]).map(
      (item) => item.id,
    );
    expect(idsReturned).toContain(team.sid);
    expect(idsReturned).not.toContain(admin.sid);

    const invalid = await request(app.server)
      .get('/api/v1/sessions?loginContext=not%20a%20slug!')
      .set('Authorization', token);
    expect(invalid.status).toBe(422);
  });

  it('exposes the contexts the current session may switch into and hides the others', async () => {
    const current = await makeSession(ids.users.teamOnly, { loginContext: 'customer-team' });
    const listed = await accountSessions(current.sid);
    expect(listed.status).toBe(200);
    const item = (
      listed.body.items as {
        id: string;
        current: boolean;
        switchableContexts?: { key: string; allowed: boolean }[];
      }[]
    ).find((entry) => entry.id === current.sid);
    expect(item?.current).toBe(true);
    // `team-only` is not a member of `customer-admin`, so it must not even be advertised.
    expect(item?.switchableContexts).toEqual([]);

    const multi = await makeSession(ids.users.multi, { loginContext: 'customer-team' });
    const multiList = await accountSessions(multi.sid);
    const multiItem = (
      multiList.body.items as {
        id: string;
        switchableContexts?: { key: string; allowed: boolean; reason?: string }[];
      }[]
    ).find((entry) => entry.id === multi.sid);
    const keys = (multiItem?.switchableContexts ?? []).map((entry) => entry.key).sort();
    expect(keys).toEqual(['customer-admin', 'ledger-admin', 'mfa-required']);
    const ledger = (multiItem?.switchableContexts ?? []).find(
      (entry) => entry.key === 'ledger-admin',
    );
    expect(ledger).toMatchObject({ allowed: false, reason: 'interaction_required' });
  });
});

describe('context switching', () => {
  it('switches an authenticated session without a password and audits the change', async () => {
    const created = await makeSession(ids.users.multi, { loginContext: 'customer-admin' });

    const response = await switchContext(created.sid, 'customer-team');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      loginContext: 'customer-team',
      previousLoginContext: 'customer-admin',
      session: { id: created.sid, loginContext: 'customer-team' },
    });
    await expect(store.read(created.sid)).resolves.toMatchObject({
      loginContext: 'customer-team',
      // Switching is not a new authentication.
      amr: ['pwd'],
      authTime: created.session.authTime,
    });
    const mirrored = await prisma.session.findUniqueOrThrow({ where: { id: created.sid } });
    expect(mirrored.loginContext).toBe('customer-team');
    expect(mirrored.revokedAt).toBeNull();

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'session.context_switch', targetId: created.sid },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.result).toBe('success');
    expect(audit.metadata).toMatchObject({ from: 'customer-admin', to: 'customer-team' });
  });

  it('refuses a switch without an active membership in the target context', async () => {
    const created = await makeSession(ids.users.teamOnly, { loginContext: 'customer-team' });

    const response = await switchContext(created.sid, 'customer-admin');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('context_membership_required');
    await expect(store.read(created.sid)).resolves.toMatchObject({
      loginContext: 'customer-team',
    });
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'session.context_switch', targetId: created.sid },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.result).toBe('failure');
    expect(audit.metadata).toMatchObject({ reason: 'membership_required' });
  });

  it('refuses a switch to a suspended context membership', async () => {
    const created = await makeSession(ids.users.suspended, { loginContext: 'customer-team' });

    const response = await switchContext(created.sid, 'customer-admin');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('context_membership_suspended');
    await expect(store.read(created.sid)).resolves.toMatchObject({
      loginContext: 'customer-team',
    });
  });

  it('refuses a switch to a disabled context or an unknown/foreign context', async () => {
    const created = await makeSession(ids.users.multi, { loginContext: 'customer-admin' });

    const disabled = await switchContext(created.sid, 'disabled-context');
    expect(disabled.status).toBe(403);
    expect(disabled.body.code).toBe('context_disabled');

    const foreign = await switchContext(created.sid, 'partner-portal');
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('context_not_found');

    const unknown = await switchContext(created.sid, 'does-not-exist');
    expect(unknown.status).toBe(404);
    await expect(store.read(created.sid)).resolves.toMatchObject({
      loginContext: 'customer-admin',
    });
  });

  it('refuses a no-op switch to the context the session already acts in', async () => {
    const created = await makeSession(ids.users.multi, { loginContext: 'customer-admin' });

    const response = await switchContext(created.sid, 'customer-admin');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('already_in_context');
  });

  it('CTX-007: requires a fresh MFA for a step-up context and never rebinds the session', async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    const created = await makeSession(ids.users.multi, {
      loginContext: 'customer-team',
      authTime: stale,
    });

    const response = await switchContext(created.sid, 'ledger-admin');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('interaction_required');
    await expect(store.read(created.sid)).resolves.toMatchObject({
      loginContext: 'customer-team',
    });
    const mirrored = await prisma.session.findUniqueOrThrow({ where: { id: created.sid } });
    expect(mirrored.loginContext).toBe('customer-team');
  });

  it('CTX-007: allows a step-up switch once the session proves a fresh second factor', async () => {
    const created = await makeSession(ids.users.multi, {
      loginContext: 'customer-team',
      amr: ['pwd', 'totp'],
      acr: MFA_ACR,
    });

    const response = await switchContext(created.sid, 'ledger-admin');

    expect(response.status).toBe(200);
    expect(response.body.loginContext).toBe('ledger-admin');
    // The identity session is not rotated by a context switch.
    await expect(store.read(created.sid)).resolves.toMatchObject({ loginContext: 'ledger-admin' });
  });

  it('enforces required_all instead of letting a password-only session in', async () => {
    const created = await makeSession(ids.users.multi, { loginContext: 'customer-team' });

    const denied = await switchContext(created.sid, 'mfa-required');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('interaction_required');
    await expect(store.read(created.sid)).resolves.toMatchObject({
      loginContext: 'customer-team',
    });

    const mfaSession = await makeSession(ids.users.multi, {
      loginContext: 'customer-team',
      amr: ['pwd', 'webauthn'],
      acr: MFA_ACR,
    });
    const allowed = await switchContext(mfaSession.sid, 'mfa-required');
    expect(allowed.status).toBe(200);
  });

  it('rejects a cross-origin switch and an invalid body', async () => {
    const created = await makeSession(ids.users.multi, { loginContext: 'customer-admin' });

    const crossOrigin = await request(app.server)
      .post('/api/v1/account/sessions/switch-context')
      .set('Cookie', cookieOf(created.sid))
      .set('Origin', 'https://evil.example')
      .send({ loginContext: 'customer-team' });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body.code).toBe('cross_origin_request');

    const invalid = await request(app.server)
      .post('/api/v1/account/sessions/switch-context')
      .set('Cookie', cookieOf(created.sid))
      .set(sameOrigin)
      .send({ loginContext: 'customer-team', extra: true });
    expect(invalid.status).toBe(422);

    const anonymous = await request(app.server)
      .post('/api/v1/account/sessions/switch-context')
      .set(sameOrigin)
      .send({ loginContext: 'customer-team' });
    expect(anonymous.status).toBe(401);
    await expect(store.read(created.sid)).resolves.toMatchObject({
      loginContext: 'customer-admin',
    });
  });
});

describe('step-up rotation', () => {
  it('rotates the session id once, keeps the context and invalidates the password-only sid', async () => {
    const created = await makeSession(ids.users.multi, { loginContext: 'ledger-admin' });
    const at = new Date();

    const upgraded = await store.stepUp(created.sid, {
      amr: ['pwd', 'totp'],
      acr: MFA_ACR,
      authTime: at,
    });

    expect(upgraded).not.toBeNull();
    expect(upgraded?.sid).not.toBe(created.sid);
    expect(upgraded?.loginContext).toBe('ledger-admin');
    expect(upgraded?.amr).toEqual(['pwd', 'totp']);
    expect(upgraded?.acr).toBe(MFA_ACR);
    expect(upgraded?.authTime).toBe(at.toISOString());
    // The stale password-only session id can never be replayed.
    await expect(store.read(created.sid)).resolves.toBeNull();
  });
});

describe('context-scoped revocation', () => {
  it('revokes only the sessions bound to the suspended context', async () => {
    const admin = await makeSession(ids.users.revoker, { loginContext: 'customer-admin' });
    const team = await makeSession(ids.users.revoker, { loginContext: 'customer-team' });
    const otherApp = await makeSession(ids.users.revoker, {
      loginContext: 'partner-portal',
      clientId: 'app-b',
    });

    const revoked = await store.revokeForUserClientContext(
      ids.users.revoker,
      'app-a',
      'customer-admin',
      'admin',
    );

    expect(revoked).toEqual([admin.sid]);
    await expect(store.read(admin.sid)).resolves.toBeNull();
    await expect(store.read(team.sid)).resolves.not.toBeNull();
    await expect(store.read(otherApp.sid)).resolves.not.toBeNull();
  });
});

describe('entering another context through /oauth2/authorize', () => {
  it('issues a code for a sibling context without a password and rebinds the session', async () => {
    const created = await makeSession(ids.users.multi, { loginContext: 'customer-admin' });

    const location = await locationOf(
      await authorize(created.sid, { loginContext: 'customer-team' }),
    );

    expect(location.searchParams.get('error')).toBeNull();
    const code = location.searchParams.get('code');
    expect(code).not.toBeNull();
    await expect(store.read(created.sid)).resolves.toMatchObject({
      loginContext: 'customer-team',
    });
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'session.context_switch', targetId: created.sid },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.metadata).toMatchObject({
      source: 'authorize',
      from: 'customer-admin',
      to: 'customer-team',
    });
  });

  it('binds a client-wide session to the requested context and records it', async () => {
    const created = await makeSession(ids.users.multi, {});

    const location = await locationOf(
      await authorize(created.sid, { loginContext: 'customer-team' }),
    );

    expect(location.searchParams.get('code')).not.toBeNull();
    await expect(store.read(created.sid)).resolves.toMatchObject({
      loginContext: 'customer-team',
    });
    const mirrored = await prisma.session.findUniqueOrThrow({ where: { id: created.sid } });
    expect(mirrored.loginContext).toBe('customer-team');
  });

  it('sends a stale password-only session to step-up instead of issuing a sensitive code', async () => {
    const created = await makeSession(ids.users.multi, {
      loginContext: 'customer-team',
      authTime: new Date(Date.now() - 10 * 60 * 1000),
    });

    const location = await locationOf(
      await authorize(created.sid, { loginContext: 'ledger-admin' }),
    );

    expect(location.searchParams.get('code')).toBeNull();
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('return_to')).toContain('login_context=ledger-admin');
    await expect(store.read(created.sid)).resolves.toMatchObject({
      loginContext: 'customer-team',
    });
  });

  it('issues a code for a step-up context with a fresh multi-factor session', async () => {
    const created = await makeSession(ids.users.multi, {
      loginContext: 'customer-team',
      amr: ['pwd', 'totp'],
      acr: MFA_ACR,
    });

    const location = await locationOf(
      await authorize(created.sid, { loginContext: 'ledger-admin' }),
    );

    expect(location.searchParams.get('error')).toBeNull();
    expect(location.searchParams.get('code')).not.toBeNull();
  });

  it('honours prompt=login instead of silently reusing the session', async () => {
    const created = await makeSession(ids.users.multi, { loginContext: 'customer-admin' });

    const location = await locationOf(
      await authorize(created.sid, {
        loginContext: 'customer-team',
        prompt: 'login',
      }),
    );

    expect(location.searchParams.get('code')).toBeNull();
    expect(location.searchParams.get('return_to')).toContain('prompt=login');
    await expect(store.read(created.sid)).resolves.toMatchObject({
      loginContext: 'customer-admin',
    });
  });

  it('returns login_required for prompt=none when a fresh authentication is required', async () => {
    const created = await makeSession(ids.users.multi, {
      loginContext: 'customer-team',
      authTime: new Date(Date.now() - 10 * 60 * 1000),
    });

    const location = await locationOf(
      await authorize(created.sid, { loginContext: 'ledger-admin', prompt: 'none' }),
    );

    expect(location.searchParams.get('error')).toBe('login_required');
    expect(location.searchParams.get('code')).toBeNull();
  });
});
