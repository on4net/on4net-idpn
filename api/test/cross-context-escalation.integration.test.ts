import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashRefreshToken } from '../src/oidc/refresh-token.js';
import {
  adminClientId,
  createCrossContextWorld,
  issuer,
  type CrossContextWorld,
} from './cross-context-harness.js';

/**
 * Cross-context escalation matrix (docs/login-contexts.md 4-9, docs/security.md T30-T32,
 * docs/testing.md INT-CTX-001..004).
 *
 * Each negative case runs against the same fixture as a positive control, so a failure
 * cannot be explained by missing memberships or roles. The two admin surfaces are checked
 * with before/after database snapshots: a `403` alone does not prove that nothing changed.
 */

let world: CrossContextWorld;
// `app` is only used as a supertest target; the concrete instance comes from the harness.
let app: CrossContextWorld['app'];

let sessionMulti: string;
let sessionDual: string;
let sessionContextOnly: string;
let sessionSuspended: string;
let sessionStepper: string;
let sessionStepperStale: string;
let sessionMfaPassword: string;
let sessionMfaStrong: string;
let dualUserId: string;
let invitedUserId: string;
let delegatedAppAuth: string;
let delegatedContextAuth: string;
let appBAppAdminAuth: string;
let globalAuth: string;

const membersPath = (clientId: string, contextKey: string): string =>
  `/api/v1/clients/${clientId}/login-contexts/${contextKey}/members`;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function expectOAuthError(location: URL, error: string): void {
  expect(location.searchParams.get('error')).toBe(error);
  expect(location.searchParams.get('error_description')).toEqual(expect.any(String));
  expect(location.searchParams.get('code')).toBeNull();
}

function expectNoToken(response: request.Response, status?: number): void {
  if (status !== undefined) {
    expect(response.status).toBe(status);
  }
  expect(response.body.access_token).toBeUndefined();
  expect(response.body.refresh_token).toBeUndefined();
}

async function inviteToContext(
  contextKey: string,
  body: Record<string, unknown>,
  authorization: string,
): Promise<request.Response> {
  return request(app.server)
    .post(`${membersPath('app-a', contextKey)}/invite`)
    .set('Authorization', authorization)
    .send({ roleKeys: [], attributes: {}, ...body });
}

beforeAll(async () => {
  world = await createCrossContextWorld('idpn_cross_context');
  app = world.app;

  const { users } = world;
  sessionMulti = await world.createSession(users.multi);
  sessionContextOnly = await world.createSession(users.contextOnly);
  sessionSuspended = await world.createSession(users.suspended);
  // A step-up context also requires a second factor in this implementation, so the positive
  // control authenticates with MFA; the stale session is a fresh password session.
  sessionStepper = await world.createSession(users.stepper, {
    acr: 'urn:on4net:acr:mfa',
    amr: ['pwd', 'totp'],
  });
  sessionStepperStale = await world.createSession(users.stepper, {
    authTime: new Date(Date.now() - 10 * 60 * 1000),
  });
  sessionMfaPassword = await world.createSession(users.mfaUser);
  sessionMfaStrong = await world.createSession(users.mfaUser, {
    acr: 'urn:on4net:acr:mfa',
    amr: ['pwd', 'totp'],
  });

  globalAuth = await world.adminAuthorization(users.admin, adminClientId, 'openid idp.admin');
  delegatedAppAuth = await world.adminAuthorization(users.delegatedApp, 'app-a');
  delegatedContextAuth = await world.adminAuthorization(users.delegatedContext, 'app-a');
  appBAppAdminAuth = await world.adminAuthorization(users.appBUserAdmin, 'app-b');

  // A user that belongs to both contexts of app-a. The role is granted through the
  // customer-admin context endpoint and must stay invisible in customer-team.
  const dualInvite = await inviteToContext(
    'customer-admin',
    { email: 'cross-dual@example.com' },
    globalAuth,
  );
  expect(dualInvite.status).toBe(201);
  dualUserId = dualInvite.body.member.userId as string;
  await request(app.server)
    .patch(`${membersPath('app-a', 'customer-admin')}/${dualUserId}`)
    .set('Authorization', globalAuth)
    .send({ status: 'active' })
    .expect(200);
  const dualTeamInvite = await inviteToContext(
    'customer-team',
    { email: 'cross-dual@example.com' },
    globalAuth,
  );
  expect(dualTeamInvite.status).toBe(201);
  await request(app.server)
    .patch(`${membersPath('app-a', 'customer-team')}/${dualUserId}`)
    .set('Authorization', globalAuth)
    .send({ status: 'active' })
    .expect(200);
  await request(app.server)
    .put(`${membersPath('app-a', 'customer-admin')}/${dualUserId}/roles`)
    .set('Authorization', globalAuth)
    .send({ roleKeys: ['app-a:customer-admin'] })
    .expect(200);
  sessionDual = await world.createSession(dualUserId);

  const invited = await inviteToContext(
    'customer-admin',
    { email: 'cross-invited-default@example.com' },
    globalAuth,
  );
  expect(invited.status).toBe(201);
  invitedUserId = invited.body.member.userId as string;
}, 300_000);

afterAll(async () => {
  await world?.close();
});

describe('role resolution cannot cross a context boundary', () => {
  it('gives two contexts of one client disjoint roles and never the role outside allowed_roles', async () => {
    const adminTokens = await world.issueTokens({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'customer-admin',
    });
    const teamTokens = await world.issueTokens({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'customer-team',
    });

    const adminClaims = await world.verify(adminTokens.access_token, 'app-a');
    expect(adminClaims.login_context).toBe('customer-admin');
    expect(adminClaims.roles).toEqual(['app-a:customer-admin', 'app-a:editor']);
    expect(adminClaims.permissions).toEqual(['app-a:contact:write', 'app-a:team:read']);
    expect(adminClaims.membership).toEqual({
      context: 'customer-admin',
      status: 'active',
      attributes: { companyId: 'c-42' },
    });

    const teamClaims = await world.verify(teamTokens.access_token, 'app-a');
    expect(teamClaims.login_context).toBe('customer-team');
    expect(teamClaims.roles).toEqual(['app-a:member']);
    expect(teamClaims.permissions).toEqual(['app-a:contact:read']);
    expect(teamClaims.membership).toEqual({
      context: 'customer-team',
      status: 'active',
      attributes: { teamId: 't-7' },
    });

    // `app-a:manager` is assigned but allowed by no context.
    for (const claims of [adminClaims, teamClaims]) {
      expect(claims.roles).not.toContain('app-a:manager');
      expect(claims.permissions).not.toContain('app-a:report:export');
    }
  });

  it('keeps a role that the other context does not allow out of that context token', async () => {
    const teamTokens = await world.issueTokens({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'customer-team',
    });
    const claims = await world.verify(teamTokens.access_token, 'app-a');

    expect(claims.roles).not.toContain('app-a:editor');
    expect(claims.roles).not.toContain('app-a:customer-admin');
    expect(claims.permissions).not.toContain('app-a:contact:write');
    expect(claims.permissions).not.toContain('app-a:team:read');
  });

  it('never puts a global idp:* role or permission in an application context token', async () => {
    for (const loginContext of ['customer-admin', 'customer-team']) {
      const tokens = await world.issueTokens({
        clientId: 'app-a',
        sessionId: sessionMulti,
        loginContext,
      });
      const claims = await world.verify(tokens.access_token, 'app-a');
      expect((claims.roles as string[]).some((key) => key.startsWith('idp:'))).toBe(false);
      expect((claims.permissions as string[]).some((key) => key.startsWith('idp:'))).toBe(false);
      expect(claims.roles).not.toContain('idp:superadmin');
      expect(claims.permissions).not.toContain('idp:user:read');
    }
  });

  it('keeps app-b roles and permissions out of every app-a context token', async () => {
    const appBTokens = await world.issueTokens({
      clientId: 'app-b',
      sessionId: sessionMulti,
      loginContext: 'partner-portal',
    });
    const appBClaims = await world.verify(appBTokens.access_token, 'app-b');
    expect(appBClaims.login_context).toBe('partner-portal');
    expect(appBClaims.roles).toEqual(['app-b:member']);
    expect(appBClaims.permissions).toEqual(['app-b:secret:read']);
    expect(appBClaims.roles).not.toContain('app-a:member');
    expect(appBClaims.permissions).not.toContain('app-a:contact:read');

    const appATokens = await world.issueTokens({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'customer-team',
    });
    const appAClaims = await world.verify(appATokens.access_token, 'app-a');
    expect(appAClaims.roles).not.toContain('app-b:member');
    expect(appAClaims.permissions).not.toContain('app-b:secret:read');
    expect(appAClaims.client_id).toBe('app-a');
    expect(appAClaims.aud).toBe('app-a');
  });

  it('applies a context default role only to a membership in that context', async () => {
    const adminInvite = await inviteToContext(
      'onboarding',
      { email: 'cross-default-admin@example.com' },
      globalAuth,
    );
    expect(adminInvite.status).toBe(201);
    expect(adminInvite.body.member.roleKeys).toEqual(['app-a:member']);

    const teamInvite = await inviteToContext(
      'customer-team',
      { email: 'cross-default-team@example.com' },
      globalAuth,
    );
    expect(teamInvite.status).toBe(201);
    expect(teamInvite.body.member.roleKeys).toEqual([]);

    const adminAssignments = await world.infra.prisma.assignment.findMany({
      where: { subjectType: 'user', subjectId: adminInvite.body.member.userId as string },
      select: { role: { select: { key: true } } },
    });
    expect(adminAssignments.map((row) => row.role.key)).toEqual(['app-a:member']);
    const teamAssignments = await world.infra.prisma.assignment.count({
      where: { subjectType: 'user', subjectId: teamInvite.body.member.userId as string },
    });
    expect(teamAssignments).toBe(0);
  });

  it('shows a role assigned through one context in that context token', async () => {
    const tokens = await world.issueTokens({
      clientId: 'app-a',
      sessionId: sessionDual,
      loginContext: 'customer-admin',
    });
    const claims = await world.verify(tokens.access_token, 'app-a');
    expect(claims.roles).toContain('app-a:customer-admin');
    expect(claims.permissions).toContain('app-a:team:read');
  });

  it('hides an assignment made for one context from the sibling context token', async () => {
    const tokens = await world.issueTokens({
      clientId: 'app-a',
      sessionId: sessionDual,
      loginContext: 'customer-team',
    });
    const claims = await world.verify(tokens.access_token, 'app-a');
    expect(claims.roles).toEqual(['app-a:member']);
    expect(claims.roles).not.toContain('app-a:customer-admin');
    expect(claims.permissions).not.toContain('app-a:team:read');
  });
});

describe('context substitution and token reuse', () => {
  it('issues a context-bound code, access token and ID token for the selected context', async () => {
    const tokens = await world.issueTokens({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'customer-admin',
    });
    const access = await world.verify(tokens.access_token, 'app-a');
    const idToken = await world.verify(tokens.id_token as string, 'app-a');
    expect(access.login_context).toBe('customer-admin');
    expect(idToken.login_context).toBe('customer-admin');
    expect(idToken.sub).toBe(world.users.multi);
  });

  it('rejects the context of another client with invalid_request', async () => {
    const location = await world.authorize({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'partner-portal',
    });
    expectOAuthError(location, 'invalid_request');
  });

  it('rejects a disabled context with invalid_request', async () => {
    const location = await world.authorize({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'disabled-context',
    });
    expectOAuthError(location, 'invalid_request');
  });

  it('rejects a nonexistent context with invalid_request', async () => {
    const location = await world.authorize({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'ghost-context',
    });
    expectOAuthError(location, 'invalid_request');
  });

  it('rejects a context the session user is not a member of with access_denied', async () => {
    const location = await world.authorize({
      clientId: 'app-a',
      sessionId: sessionContextOnly,
      loginContext: 'customer-team',
    });
    expectOAuthError(location, 'access_denied');
  });

  it('ignores a mutated login_context on a code exchange and keeps the code context', async () => {
    const location = await world.authorize({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'customer-admin',
    });
    const code = location.searchParams.get('code');
    expect(code).toEqual(expect.any(String));

    const response = await world.exchangeCode({
      clientId: 'app-a',
      code: code as string,
      loginContext: 'customer-team',
    });
    expect(response.status).toBe(200);
    const claims = await world.verify(response.body.access_token as string, 'app-a');
    expect(claims.login_context).toBe('customer-admin');
    expect(claims.roles).toEqual(['app-a:customer-admin', 'app-a:editor']);
    expect(claims.membership).toMatchObject({ context: 'customer-admin' });
  });

  it('cannot upgrade an unbound code to a context by adding login_context', async () => {
    const location = await world.authorize({ clientId: 'app-a', sessionId: sessionMulti });
    const code = location.searchParams.get('code');
    expect(code).toEqual(expect.any(String));

    const response = await world.exchangeCode({
      clientId: 'app-a',
      code: code as string,
      loginContext: 'customer-team',
    });
    expect(response.status).toBe(200);
    const claims = await world.verify(response.body.access_token as string, 'app-a');
    expect(claims.login_context).toBeUndefined();
    expect(claims.membership).toEqual({
      context: null,
      status: 'active',
      attributes: { legacy: true },
    });
    // Unbound requests follow the documented legacy path: no context attributes leak.
    expect(claims.membership).not.toMatchObject({ attributes: { teamId: 't-7' } });
  });

  it('ignores a mutated login_context on refresh and keeps the stored context', async () => {
    const tokens = await world.issueTokens({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'customer-admin',
      scope: 'openid offline_access',
    });
    expect(tokens.refresh_token).toEqual(expect.any(String));

    const response = await world.refresh({
      clientId: 'app-a',
      token: tokens.refresh_token as string,
      loginContext: 'customer-team',
    });
    expect(response.status).toBe(200);
    const claims = await world.verify(response.body.access_token as string, 'app-a');
    expect(claims.login_context).toBe('customer-admin');
    expect(claims.roles).toEqual(['app-a:customer-admin', 'app-a:editor']);

    const stored = await world.infra.prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(response.body.refresh_token as string) },
      select: { loginContext: true },
    });
    expect(stored.loginContext).toBe('customer-admin');
  });

  it('refuses to use a refresh token from another client', async () => {
    const tokens = await world.issueTokens({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'customer-team',
      scope: 'openid offline_access',
    });

    const response = await world.refresh({
      clientId: 'app-b',
      token: tokens.refresh_token as string,
    });
    expectNoToken(response);
    expect(response.status).toBe(400);
  });

  it('refuses a code exchange after the context was disabled and burns the code', async () => {
    const location = await world.authorize({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'customer-team',
    });
    const code = location.searchParams.get('code') as string;
    await world.infra.prisma.clientLoginContext.update({
      where: { clientId_key: { clientId: world.clients.appA, key: 'customer-team' } },
      data: { status: 'disabled' },
    });

    try {
      const response = await world.exchangeCode({ clientId: 'app-a', code });
      expectNoToken(response, 400);
      expect(response.body.error).toBe('access_denied');

      const replay = await world.exchangeCode({ clientId: 'app-a', code });
      expectNoToken(replay, 400);
      expect(replay.body.error).toBe('invalid_grant');
    } finally {
      await world.infra.prisma.clientLoginContext.update({
        where: { clientId_key: { clientId: world.clients.appA, key: 'customer-team' } },
        data: { status: 'active' },
      });
    }
  });

  it('refuses refresh after the context was disabled and revokes the family', async () => {
    const tokens = await world.issueTokens({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'customer-team',
      scope: 'openid offline_access',
    });
    await world.infra.prisma.clientLoginContext.update({
      where: { clientId_key: { clientId: world.clients.appA, key: 'customer-team' } },
      data: { status: 'disabled' },
    });

    try {
      const response = await world.refresh({
        clientId: 'app-a',
        token: tokens.refresh_token as string,
      });
      expectNoToken(response, 400);
      expect(response.body.error).toBe('invalid_grant');

      // Only this token's family must be revoked; other grants of the same context survive.
      const current = await world.infra.prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: hashRefreshToken(tokens.refresh_token as string) },
        select: { familyId: true },
      });
      const family = await world.infra.prisma.refreshToken.findMany({
        where: { familyId: current.familyId },
        select: { revokedAt: true },
      });
      expect(family.length).toBeGreaterThan(0);
      expect(family.every((row) => row.revokedAt !== null)).toBe(true);
    } finally {
      await world.infra.prisma.clientLoginContext.update({
        where: { clientId_key: { clientId: world.clients.appA, key: 'customer-team' } },
        data: { status: 'active' },
      });
    }
  });

  it('follows the documented unbound path for a client-wide membership', async () => {
    const tokens = await world.issueTokens({ clientId: 'app-a', sessionId: sessionMulti });
    const claims = await world.verify(tokens.access_token, 'app-a');
    expect(claims.login_context).toBeUndefined();
    expect(claims.roles).toEqual([
      'app-a:customer-admin',
      'app-a:editor',
      'app-a:manager',
      'app-a:member',
    ]);
    expect(claims.membership).toEqual({
      context: null,
      status: 'active',
      attributes: { legacy: true },
    });
  });

  it('fails closed when login_context is omitted and no client-wide membership exists', async () => {
    const location = await world.authorize({
      clientId: 'app-a',
      sessionId: sessionContextOnly,
    });
    expectOAuthError(location, 'access_denied');
  });

  it('cannot bypass a suspended context membership by omitting login_context', async () => {
    const location = await world.authorize({
      clientId: 'app-a',
      sessionId: sessionSuspended,
    });
    expectOAuthError(location, 'access_denied');
  });
});

describe('delegated context administration stays inside its scope', () => {
  it('lets a context admin manage its own context and persists the changes', async () => {
    const list = await request(app.server)
      .get(membersPath('app-a', 'customer-admin'))
      .set('Authorization', delegatedContextAuth)
      .expect(200);
    expect(list.body.items.map((item: { userId: string }) => item.userId)).toContain(
      world.users.delegatedContext,
    );

    const invited = await inviteToContext(
      'customer-admin',
      { email: 'cross-managed-by-context-admin@example.com', roleKeys: ['app-a:editor'] },
      delegatedContextAuth,
    );
    expect(invited.status).toBe(201);
    expect(invited.body.member).toMatchObject({
      loginContextKey: 'customer-admin',
      status: 'invited',
      roleKeys: ['app-a:editor'],
    });
    const userId = invited.body.member.userId as string;

    const activated = await request(app.server)
      .patch(`${membersPath('app-a', 'customer-admin')}/${userId}`)
      .set('Authorization', delegatedContextAuth)
      .send({ status: 'active' })
      .expect(200);
    expect(activated.body.status).toBe('active');

    const roles = await request(app.server)
      .put(`${membersPath('app-a', 'customer-admin')}/${userId}/roles`)
      .set('Authorization', delegatedContextAuth)
      .send({ roleKeys: ['app-a:editor', 'app-a:customer-admin'] })
      .expect(200);
    expect(roles.body.roleKeys.sort()).toEqual(['app-a:customer-admin', 'app-a:editor']);

    const membership = await world.infra.prisma.clientMembership.findFirstOrThrow({
      where: {
        clientId: world.clients.appA,
        userId,
        loginContextId: world.contexts.customerAdmin,
      },
      select: { status: true },
    });
    expect(membership.status).toBe('active');
  });

  it('denies reads and invitations in another context of the same client and writes nothing', async () => {
    const before = await world.snapshot('app-a');
    const path = membersPath('app-a', 'customer-team');

    const list = await request(app.server).get(path).set('Authorization', delegatedContextAuth);
    expect(list.status).toBe(403);

    const invited = await inviteToContext(
      'customer-team',
      { email: 'cross-context-intruder@example.com', roleKeys: [] },
      delegatedContextAuth,
    );
    expect(invited.status).toBe(403);

    await expect(world.snapshot('app-a')).resolves.toEqual(before);
    expect(
      await world.infra.prisma.user.findFirst({
        where: { email: 'cross-context-intruder@example.com' },
        select: { id: true },
      }),
    ).toBeNull();
  });

  it('denies mutations in another context and proves the target is unchanged', async () => {
    const target = world.users.target;
    const before = await world.snapshot('app-a');
    const path = `${membersPath('app-a', 'customer-team')}/${target}`;

    const patched = await request(app.server)
      .patch(path)
      .set('Authorization', delegatedContextAuth)
      .send({ status: 'suspended' });
    expect(patched.status).toBe(403);

    const deleted = await request(app.server)
      .delete(path)
      .set('Authorization', delegatedContextAuth);
    expect(deleted.status).toBe(403);

    const roles = await request(app.server)
      .put(`${path}/roles`)
      .set('Authorization', delegatedContextAuth)
      .send({ roleKeys: ['app-a:manager'] });
    expect(roles.status).toBe(403);

    await expect(world.snapshot('app-a')).resolves.toEqual(before);
  });

  it('denies the same context key on another client', async () => {
    const before = await world.snapshot('app-b');
    const path = membersPath('app-b', 'partner-portal');

    const list = await request(app.server).get(path).set('Authorization', delegatedContextAuth);
    expect(list.status).toBe(403);

    const invited = await request(app.server)
      .post(`${path}/invite`)
      .set('Authorization', delegatedContextAuth)
      .send({ email: 'cross-other-client@example.com', roleKeys: [] });
    expect(invited.status).toBe(403);

    await expect(world.snapshot('app-b')).resolves.toEqual(before);
  });

  it('cannot change allowed_roles, default_roles or the MFA policy through member endpoints', async () => {
    const before = await world.snapshot('app-a');

    // The member schema has no policy fields; unknown keys must be ignored, not applied.
    await request(app.server)
      .patch(`${membersPath('app-a', 'customer-admin')}/${world.users.delegatedContext}`)
      .set('Authorization', delegatedContextAuth)
      .send({
        status: 'active',
        allowedRoles: ['app-a:manager'],
        defaultRoles: ['app-a:manager'],
        mfaPolicy: 'required_all',
      })
      .expect(200);

    const invited = await inviteToContext(
      'customer-admin',
      {
        email: 'cross-policy-via-member@example.com',
        allowedRoles: ['app-a:manager'],
        defaultRoles: ['app-a:manager'],
        mfaPolicy: 'required_all',
      },
      delegatedContextAuth,
    );
    expect(invited.status).toBe(201);
    // The member body is not a policy surface: only the context rows are compared.
    expect(invited.body.member.roleKeys).toEqual([]);

    const after = await world.snapshot('app-a');
    expect(after.contexts).toEqual(before.contexts);
    const stored = await world.infra.prisma.clientLoginContext.findFirstOrThrow({
      where: { clientId: world.clients.appA, key: 'customer-admin' },
      select: { allowedRoles: true, defaultRoles: true, mfaPolicy: true },
    });
    expect(stored.allowedRoles).not.toContain('app-a:manager');
    expect(stored.defaultRoles).not.toContain('app-a:manager');
    expect(stored.mfaPolicy).toBe('optional');
  });

  it('cannot use the client-wide membership surface to invite or assign beyond its context', async () => {
    const before = await world.snapshot('app-a');

    const list = await request(app.server)
      .get('/api/v1/clients/app-a/members')
      .set('Authorization', delegatedContextAuth);
    expect(list.status).toBe(403);

    const invite = await request(app.server)
      .post('/api/v1/clients/app-a/members/invite')
      .set('Authorization', delegatedContextAuth)
      .send({
        email: 'cross-escalated-invite@example.com',
        roleKeys: ['app-a:manager'],
        attributes: {},
      });
    expect(invite.status).toBe(403);

    const selfRoles = await request(app.server)
      .put(`/api/v1/clients/app-a/members/${world.users.delegatedContext}/roles`)
      .set('Authorization', delegatedContextAuth)
      .send({ roleKeys: ['app-a:manager'] });
    expect(selfRoles.status).toBe(403);

    await expect(world.snapshot('app-a')).resolves.toEqual(before);
    expect(
      await world.infra.prisma.user.findFirst({
        where: { email: 'cross-escalated-invite@example.com' },
        select: { id: true },
      }),
    ).toBeNull();

    const denials = await world.infra.prisma.auditEvent.count({
      where: { action: 'member.scope.denied', actorId: world.users.delegatedContext },
    });
    expect(denials).toBeGreaterThanOrEqual(3);
  });

  it('denies a suspended context admin on the client-wide surface instead of widening it', async () => {
    const prisma = world.infra.prisma;
    const user = await prisma.user.create({
      data: {
        tenantId: world.infra.tenantId,
        username: 'cross-suspended-context-admin',
        email: 'cross-suspended-context-admin@example.com',
        displayName: 'cross-suspended-context-admin',
        status: 'active',
      },
      select: { id: true },
    });
    await prisma.assignment.create({
      data: {
        subjectType: 'user',
        subjectId: user.id,
        roleId: world.roles.appAContextAdmin,
        scopeType: 'global',
        assignedBy: world.users.admin,
      },
    });
    await prisma.clientMembership.create({
      data: {
        clientId: world.clients.appA,
        userId: user.id,
        loginContextId: world.contexts.customerAdmin,
        status: 'suspended',
      },
    });
    const authorization = await world.adminAuthorization(user.id, 'app-a');
    const before = await world.snapshot('app-a');

    const list = await request(app.server)
      .get('/api/v1/clients/app-a/members')
      .set('Authorization', authorization);
    expect(list.status).toBe(403);

    const invite = await request(app.server)
      .post('/api/v1/clients/app-a/members/invite')
      .set('Authorization', authorization)
      .send({ email: 'cross-suspended-admin-invite@example.com', roleKeys: [] });
    expect(invite.status).toBe(403);

    await expect(world.snapshot('app-a')).resolves.toEqual(before);
  });

  it('still lets an app-level delegated admin manage the client-wide membership surface', async () => {
    const invited = await request(app.server)
      .post('/api/v1/clients/app-a/members/invite')
      .set('Authorization', delegatedAppAuth)
      .send({
        email: 'cross-app-admin-managed@example.com',
        roleKeys: ['app-a:manager'],
        attributes: {},
      })
      .expect(201);
    const userId = invited.body.member.userId as string;

    const roles = await request(app.server)
      .put(`/api/v1/clients/app-a/members/${userId}/roles`)
      .set('Authorization', delegatedAppAuth)
      .send({ roleKeys: ['app-a:manager'] })
      .expect(200);
    expect(roles.body.roleKeys).toEqual(['app-a:manager']);

    await request(app.server)
      .delete(`/api/v1/clients/app-a/members/${userId}`)
      .set('Authorization', delegatedAppAuth)
      .expect(204);
  });

  it('does not let another client administrator act on app-a', async () => {
    const before = await world.snapshot('app-a');
    const attempts = [
      request(app.server)
        .get(membersPath('app-a', 'customer-admin'))
        .set('Authorization', appBAppAdminAuth),
      request(app.server)
        .post(`${membersPath('app-a', 'customer-admin')}/invite`)
        .set('Authorization', appBAppAdminAuth)
        .send({ email: 'cross-from-app-b@example.com', roleKeys: [] }),
      request(app.server)
        .put(`/api/v1/clients/app-a/members/${world.users.target}/roles`)
        .set('Authorization', appBAppAdminAuth)
        .send({ roleKeys: ['app-a:manager'] }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(403);
    }
    await expect(world.snapshot('app-a')).resolves.toEqual(before);
  });
});

describe('membership state cannot be bypassed across contexts', () => {
  it('keeps the sibling context membership and its access after one context is deleted', async () => {
    const prisma = world.infra.prisma;
    const user = await prisma.user.create({
      data: {
        tenantId: world.infra.tenantId,
        username: 'cross-delete-a',
        email: 'cross-delete-a@example.com',
        displayName: 'cross-delete-a',
        status: 'active',
      },
      select: { id: true },
    });
    for (const contextId of [world.contexts.customerAdmin, world.contexts.customerTeam]) {
      await prisma.clientMembership.create({
        data: {
          clientId: world.clients.appA,
          userId: user.id,
          loginContextId: contextId,
          status: 'active',
          joinedAt: new Date(),
        },
      });
    }
    for (const roleId of [world.roles.appAEditor, world.roles.appAMember]) {
      await prisma.assignment.create({
        data: {
          subjectType: 'user',
          subjectId: user.id,
          roleId,
          scopeType: 'global',
          assignedBy: world.users.admin,
        },
      });
    }
    const session = await world.createSession(user.id);

    await request(app.server)
      .delete(`${membersPath('app-a', 'customer-admin')}/${user.id}`)
      .set('Authorization', globalAuth)
      .expect(204);

    const rows = await prisma.clientMembership.findMany({
      where: { clientId: world.clients.appA, userId: user.id },
      select: { loginContextId: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.loginContextId).toBe(world.contexts.customerTeam);

    const teamTokens = await world.issueTokens({
      clientId: 'app-a',
      sessionId: session,
      loginContext: 'customer-team',
    });
    const claims = await world.verify(teamTokens.access_token, 'app-a');
    expect(claims.roles).toEqual(['app-a:member']);
    expect(claims.membership).toMatchObject({ context: 'customer-team' });

    const adminLocation = await world.authorize({
      clientId: 'app-a',
      sessionId: session,
      loginContext: 'customer-admin',
    });
    expectOAuthError(adminLocation, 'access_denied');
  });

  it('applies a suspended context membership even when a client-wide membership is active', async () => {
    const prisma = world.infra.prisma;
    const user = await prisma.user.create({
      data: {
        tenantId: world.infra.tenantId,
        username: 'cross-suspended-fallback',
        email: 'cross-suspended-fallback@example.com',
        displayName: 'cross-suspended-fallback',
        status: 'active',
      },
      select: { id: true },
    });
    await prisma.clientMembership.createMany({
      data: [
        {
          clientId: world.clients.appA,
          userId: user.id,
          loginContextId: null,
          status: 'active',
          joinedAt: new Date(),
        },
        {
          clientId: world.clients.appA,
          userId: user.id,
          loginContextId: world.contexts.customerAdmin,
          status: 'suspended',
        },
      ],
    });
    await prisma.assignment.create({
      data: {
        subjectType: 'user',
        subjectId: user.id,
        roleId: world.roles.appAEditor,
        scopeType: 'global',
        assignedBy: world.users.admin,
      },
    });
    const session = await world.createSession(user.id);

    const location = await world.authorize({
      clientId: 'app-a',
      sessionId: session,
      loginContext: 'customer-admin',
    });
    expectOAuthError(location, 'access_denied');
  });

  it('rejects a duplicate context membership at the database boundary', async () => {
    const prisma = world.infra.prisma;
    const existing = await prisma.clientMembership.findFirstOrThrow({
      where: {
        clientId: world.clients.appA,
        userId: world.users.multi,
        loginContextId: world.contexts.customerAdmin,
      },
      select: { id: true },
    });

    await expect(
      prisma.clientMembership.create({
        data: {
          clientId: world.clients.appA,
          userId: world.users.multi,
          loginContextId: world.contexts.customerAdmin,
          status: 'active',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(
      await prisma.clientMembership.count({
        where: {
          clientId: world.clients.appA,
          userId: world.users.multi,
          loginContextId: world.contexts.customerAdmin,
        },
      }),
    ).toBe(1);
    expect(existing.id).toEqual(expect.any(String));
  });

  it('rejects a duplicate client-wide membership at the database boundary', async () => {
    const prisma = world.infra.prisma;
    await expect(
      prisma.clientMembership.create({
        data: {
          clientId: world.clients.appA,
          userId: world.users.multi,
          loginContextId: null,
          status: 'active',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(
      await prisma.clientMembership.count({
        where: {
          clientId: world.clients.appA,
          userId: world.users.multi,
          loginContextId: null,
        },
      }),
    ).toBe(1);
  });

  it('never leaks membership attributes from another context or client', async () => {
    const adminTokens = await world.issueTokens({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'customer-admin',
    });
    const teamTokens = await world.issueTokens({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'customer-team',
    });
    const partnerTokens = await world.issueTokens({
      clientId: 'app-b',
      sessionId: sessionMulti,
      loginContext: 'partner-portal',
    });

    const adminClaims = await world.verify(adminTokens.access_token, 'app-a');
    const teamClaims = await world.verify(teamTokens.access_token, 'app-a');
    const partnerClaims = await world.verify(partnerTokens.access_token, 'app-b');

    expect(adminClaims.membership).toEqual({
      context: 'customer-admin',
      status: 'active',
      attributes: { companyId: 'c-42' },
    });
    expect(teamClaims.membership).toEqual({
      context: 'customer-team',
      status: 'active',
      attributes: { teamId: 't-7' },
    });
    expect(partnerClaims.membership).toEqual({
      context: 'partner-portal',
      status: 'active',
      attributes: { partner: true },
    });
  });

  it('gives no access to an invited membership even though its default roles were assigned', async () => {
    const session = await world.createSession(invitedUserId);

    const withContext = await world.authorize({
      clientId: 'app-a',
      sessionId: session,
      loginContext: 'customer-admin',
    });
    expectOAuthError(withContext, 'access_denied');

    const withoutContext = await world.authorize({ clientId: 'app-a', sessionId: session });
    expectOAuthError(withoutContext, 'access_denied');
  });
});

describe('token and userinfo claims stay scoped to the context', () => {
  it('issues exactly the context roles, permissions and membership claims', async () => {
    const tokens = await world.issueTokens({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'customer-team',
      scope: 'openid profile email',
    });
    const claims = await world.verify(tokens.access_token, 'app-a');

    expect(claims.iss).toBe(issuer);
    expect(claims.sub).toBe(world.users.multi);
    expect(claims.aud).toBe('app-a');
    expect(claims.client_id).toBe('app-a');
    expect(claims.login_context).toBe('customer-team');
    expect(claims.roles).toEqual(['app-a:member']);
    expect(claims.permissions).toEqual(['app-a:contact:read']);
    expect(claims.membership).toEqual({
      context: 'customer-team',
      status: 'active',
      attributes: { teamId: 't-7' },
    });
    expect(claims.tenant_id).toBe(world.infra.tenantId);
  });

  it('resolves the userinfo fallback for the token context, not another context', async () => {
    const sign = (loginContext: string) =>
      world.infra.keys.signAccessToken(
        {
          scope: 'openid',
          client_id: 'app-a',
          token_use: 'access',
          auth_time: nowSeconds(),
          login_context: loginContext,
          permissions_source: 'userinfo',
        },
        {
          issuer,
          audience: 'app-a',
          subject: world.users.multi,
          expiresInSeconds: 300,
        },
      );

    const team = await request(app.server)
      .get('/oauth2/userinfo')
      .set('Authorization', `Bearer ${await sign('customer-team')}`)
      .expect(200);
    expect(team.body.roles).toEqual(['app-a:member']);
    expect(team.body.permissions).toEqual(['app-a:contact:read']);
    expect(team.body.membership).toEqual({
      context: 'customer-team',
      status: 'active',
      attributes: { teamId: 't-7' },
    });

    const admin = await request(app.server)
      .get('/oauth2/userinfo')
      .set('Authorization', `Bearer ${await sign('customer-admin')}`)
      .expect(200);
    expect(admin.body.roles).toEqual(['app-a:customer-admin', 'app-a:editor']);
    expect(admin.body.roles).not.toContain('app-a:manager');
    expect(admin.body.permissions).not.toContain('app-a:contact:read');
    expect(admin.body.membership).toMatchObject({ context: 'customer-admin' });
  });

  it('withdraws userinfo roles when the context membership is suspended', async () => {
    const token = await world.infra.keys.signAccessToken(
      {
        scope: 'openid',
        client_id: 'app-a',
        token_use: 'access',
        auth_time: nowSeconds(),
        login_context: 'customer-admin',
        permissions_source: 'userinfo',
      },
      {
        issuer,
        audience: 'app-a',
        subject: world.users.suspended,
        expiresInSeconds: 300,
      },
    );
    const response = await request(app.server)
      .get('/oauth2/userinfo')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.roles).toEqual([]);
    expect(response.body.permissions).toEqual([]);
    expect(response.body.membership).toMatchObject({
      context: 'customer-admin',
      status: 'suspended',
    });
  });

  it('refuses to issue a code for a required_all context from a password-only session', async () => {
    const location = await world.authorize({
      clientId: 'app-a',
      sessionId: sessionMfaPassword,
      loginContext: 'mfa-required',
      prompt: 'none',
    });
    expectOAuthError(location, 'login_required');
  });

  it('issues the context token once the session satisfies the context MFA policy', async () => {
    const tokens = await world.issueTokens({
      clientId: 'app-a',
      sessionId: sessionMfaStrong,
      loginContext: 'mfa-required',
    });
    const claims = await world.verify(tokens.access_token, 'app-a');
    expect(claims.login_context).toBe('mfa-required');
    expect(claims.roles).toEqual(['app-a:member']);
    expect(claims.acr).toBe('urn:on4net:acr:mfa');
  });

  it('refuses a step-up context with a stale authentication', async () => {
    const location = await world.authorize({
      clientId: 'app-a',
      sessionId: sessionStepperStale,
      loginContext: 'ledger-admin',
      prompt: 'none',
    });
    expectOAuthError(location, 'login_required');
  });

  it('issues a step-up context token with a fresh authentication', async () => {
    const tokens = await world.issueTokens({
      clientId: 'app-a',
      sessionId: sessionStepper,
      loginContext: 'ledger-admin',
    });
    const claims = await world.verify(tokens.access_token, 'app-a');
    expect(claims.login_context).toBe('ledger-admin');
    expect(claims.roles).toEqual(['app-a:manager']);
    expect(claims.permissions).toEqual(['app-a:report:export']);
  });

  it('does not let acr_values upgrade a password session without a second factor', async () => {
    const location = await world.authorize({
      clientId: 'app-a',
      sessionId: sessionMulti,
      loginContext: 'customer-team',
      prompt: 'none',
      acrValues: 'urn:on4net:acr:mfa',
    });
    expectOAuthError(location, 'login_required');
  });
});
