import request from 'supertest';

import { createPrismaLoginContextRepository } from '../src/admin/login-contexts/prisma-login-context-repository.js';
import { createPrismaMemberRepository } from '../src/admin/members/prisma-member-repository.js';
import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { createPrismaRbacRepository } from '../src/admin/rbac/prisma-rbac-repository.js';
import { createPrismaMfaRepository } from '../src/mfa/prisma-repository.js';
import {
  createAuthorizeAuthenticationRequirement,
  createAuthorizeMembershipStatus,
} from '../src/oidc/authorize-enforcement.js';
import { s256Challenge } from '../src/oidc/authorization-code.js';
import { createPrismaEffectiveAccessSource } from '../src/oidc/effective-access.js';
import { createPrismaLoginContextAccessSource } from '../src/oidc/login-context-access.js';
import { createPrismaClientRepository } from '../src/oidc/prisma-client-repository.js';
import { createPrismaCodeRepository } from '../src/oidc/prisma-code-repository.js';
import { createPrismaRefreshTokenRepository } from '../src/oidc/prisma-refresh-repository.js';
import { createPrismaUserRepository } from '../src/oidc/prisma-user-repository.js';
import { buildServer } from '../src/server.js';
import type { IdpSession } from '../src/session/types.js';
import { startPhase4Infra, type Phase4Infra } from './phase4-harness.js';

/**
 * Shared world for the cross-context escalation matrix
 * (`docs/login-contexts.md` 4-9, `docs/security.md` T30-T32).
 *
 * Two apps own independent login contexts; one user is a member of both contexts of app-a
 * and of app-b, so every negative case has a positive control with exactly the same data.
 * Sessions live in memory because `/authorize` only needs `authTime`/`acr`/`amr`, and the
 * Postgres mirror stays available for refresh-time revocation checks.
 */

export const issuer = 'http://127.0.0.1:3400';
export const adminClientId = 'admin-panel';
export const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';

export const REDIRECT_URI = {
  'app-a': 'https://app-a.example.com/callback',
  'app-b': 'https://app-b.example.com/callback',
} as const;

export type AppClientId = keyof typeof REDIRECT_URI;

export interface RoleIds {
  appAMember: string;
  appAEditor: string;
  appAManager: string;
  appACustomerAdmin: string;
  appBMember: string;
  appBUserAdmin: string;
  idpSuperadmin: string;
  appAUserAdmin: string;
  appAContextAdmin: string;
  membershipAdmin: string;
}

export interface ContextIds {
  customerAdmin: string;
  customerTeam: string;
  onboarding: string;
  mfaRequired: string;
  stepUp: string;
  disabled: string;
  partnerPortal: string;
}

export interface UserIds {
  admin: string;
  multi: string;
  contextOnly: string;
  suspended: string;
  stepper: string;
  mfaUser: string;
  target: string;
  delegatedApp: string;
  delegatedContext: string;
  appBUserAdmin: string;
}

export interface IssuedTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  scope: string;
}

export interface SessionOptions {
  authTime?: Date;
  acr?: string;
  amr?: string[];
}

export interface ClientSnapshot {
  contexts: {
    key: string;
    status: string;
    allowedRoles: string[];
    defaultRoles: string[];
    mfaPolicy: string;
    stepUpRequired: boolean;
    isDefault: boolean;
  }[];
  roles: { key: string; permissions: string[] }[];
  memberships: { userId: string; contextId: string | null; status: string }[];
  assignments: { roleKey: string; subjectId: string }[];
  userCount: number;
}

export interface CrossContextWorld {
  infra: Phase4Infra;
  app: ReturnType<typeof buildServer>;
  clients: { appA: string; appB: string };
  roles: RoleIds;
  contexts: ContextIds;
  users: UserIds;
  createSession(userId: string, options?: SessionOptions): Promise<string>;
  authorize(params: {
    clientId: AppClientId;
    sessionId?: string;
    loginContext?: string;
    prompt?: string;
    scope?: string;
    acrValues?: string;
  }): Promise<URL>;
  issueTokens(params: {
    clientId: AppClientId;
    sessionId: string;
    loginContext?: string;
    scope?: string;
  }): Promise<IssuedTokens>;
  exchangeCode(params: {
    clientId: AppClientId;
    code: string;
    loginContext?: string;
    redirectUri?: string;
  }): Promise<request.Response>;
  refresh(params: {
    clientId: AppClientId;
    token: string;
    loginContext?: string;
  }): Promise<request.Response>;
  adminAuthorization(
    userId: string,
    clientId: string,
    scope?: string,
    extra?: Record<string, unknown>,
  ): Promise<string>;
  verify(token: string, audience?: string): Promise<Record<string, unknown>>;
  snapshot(clientId: AppClientId): Promise<ClientSnapshot>;
  close(): Promise<void>;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export async function createCrossContextWorld(prefix: string): Promise<CrossContextWorld> {
  const infra = await startPhase4Infra(prefix);
  const { prisma, keys, tenantId } = infra;
  const sessions = new Map<string, IdpSession>();

  const createClient = (
    clientId: string,
    scopes: string[],
    options: { redirectUris?: string[]; defaultLoginContextKey?: string } = {},
  ) =>
    prisma.client.create({
      data: {
        clientId,
        name: clientId,
        type: 'spa',
        redirectUris: options.redirectUris ?? [],
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        scopes,
        defaultLoginContextKey: options.defaultLoginContextKey ?? null,
        tenantId,
      },
      select: { id: true },
    });

  await createClient(adminClientId, ['openid', 'idp.admin']);
  const appA = await createClient(
    'app-a',
    ['openid', 'profile', 'email', 'offline_access', 'idp.client-admin'],
    { redirectUris: [REDIRECT_URI['app-a']] },
  );
  const appB = await createClient('app-b', ['openid', 'offline_access', 'idp.client-admin'], {
    redirectUris: [REDIRECT_URI['app-b']],
  });

  const createPermission = async (key: string, clientId: string | null) =>
    prisma.permission.create({ data: { key, description: key, clientId }, select: { id: true } });

  const appAContactRead = await createPermission('app-a:contact:read', appA.id);
  const appAContactWrite = await createPermission('app-a:contact:write', appA.id);
  const appAReportExport = await createPermission('app-a:report:export', appA.id);
  const appATeamRead = await createPermission('app-a:team:read', appA.id);
  const appBSecretRead = await createPermission('app-b:secret:read', appB.id);
  const idpUserRead = await createPermission('idp:user:read', null);

  const memberPermissions = [];
  for (const key of [
    'idp:client-member:read',
    'idp:client-member:invite',
    'idp:client-member:write',
    'idp:client-role:assign',
    'idp:client-session:read',
  ]) {
    memberPermissions.push(await createPermission(key, null));
  }

  const createRole = (
    key: string,
    clientId: string | null,
    permissions: { id: string }[],
    isDefault = false,
  ) =>
    prisma.role.create({
      data: {
        key,
        name: key,
        description: key,
        clientId,
        isDefault,
        rolePermissions: { create: permissions.map((entry) => ({ permissionId: entry.id })) },
      },
      select: { id: true },
    });

  const appAMember = await createRole('app-a:member', appA.id, [appAContactRead]);
  const appAEditor = await createRole('app-a:editor', appA.id, [appAContactWrite]);
  const appAManager = await createRole('app-a:manager', appA.id, [appAReportExport]);
  const appACustomerAdmin = await createRole('app-a:customer-admin', appA.id, [appATeamRead]);
  const appBMember = await createRole('app-b:member', appB.id, [appBSecretRead]);
  const idpSuperadmin = await createRole('idp:superadmin', null, [idpUserRead]);
  const appAUserAdmin = await createRole('app-a:user-admin', appA.id, memberPermissions);
  const appBUserAdmin = await createRole('app-b:user-admin', appB.id, memberPermissions);
  const appAContextAdmin = await createRole(
    'app-a:context-admin-customer-admin',
    appA.id,
    memberPermissions,
  );
  const membershipAdmin = await createRole('membership-admin', null, memberPermissions);

  const roles: RoleIds = {
    appAMember: appAMember.id,
    appAEditor: appAEditor.id,
    appAManager: appAManager.id,
    appACustomerAdmin: appACustomerAdmin.id,
    appBMember: appBMember.id,
    appBUserAdmin: appBUserAdmin.id,
    idpSuperadmin: idpSuperadmin.id,
    appAUserAdmin: appAUserAdmin.id,
    appAContextAdmin: appAContextAdmin.id,
    membershipAdmin: membershipAdmin.id,
  };

  const createContext = (
    clientId: string,
    key: string,
    options: {
      allowedRoles: string[];
      defaultRoles?: string[];
      isDefault?: boolean;
      status?: 'active' | 'disabled';
      mfaPolicy?: 'optional' | 'required_admins' | 'required_all';
      stepUpRequired?: boolean;
    },
  ) =>
    prisma.clientLoginContext.create({
      data: {
        clientId,
        key,
        name: key,
        allowedRoles: options.allowedRoles,
        defaultRoles: options.defaultRoles ?? [],
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

  const customerAdmin = await createContext(appA.id, 'customer-admin', {
    allowedRoles: ['app-a:editor', 'app-a:customer-admin'],
    defaultRoles: ['app-a:member'],
    isDefault: true,
  });
  const customerTeam = await createContext(appA.id, 'customer-team', {
    allowedRoles: ['app-a:member'],
  });
  // `default_roles` must be a subset of `allowed_roles`; this context proves the default is
  // applied only where it is declared.
  const onboarding = await createContext(appA.id, 'onboarding', {
    allowedRoles: ['app-a:member'],
    defaultRoles: ['app-a:member'],
  });
  const mfaRequired = await createContext(appA.id, 'mfa-required', {
    allowedRoles: ['app-a:member'],
    mfaPolicy: 'required_all',
  });
  const stepUp = await createContext(appA.id, 'ledger-admin', {
    allowedRoles: ['app-a:manager'],
    stepUpRequired: true,
  });
  const disabled = await createContext(appA.id, 'disabled-context', {
    allowedRoles: ['app-a:manager'],
    status: 'disabled',
  });
  const partnerPortal = await createContext(appB.id, 'partner-portal', {
    allowedRoles: ['app-b:member'],
    isDefault: true,
  });

  const contexts: ContextIds = {
    customerAdmin: customerAdmin.id,
    customerTeam: customerTeam.id,
    onboarding: onboarding.id,
    mfaRequired: mfaRequired.id,
    stepUp: stepUp.id,
    disabled: disabled.id,
    partnerPortal: partnerPortal.id,
  };

  // The client row mirrors `is_default`, like the admin API does (docs/login-contexts.md 3.1).
  await prisma.client.update({
    where: { id: appA.id },
    data: { defaultLoginContextKey: 'customer-admin' },
  });
  await prisma.client.update({
    where: { id: appB.id },
    data: { defaultLoginContextKey: 'partner-portal' },
  });

  const createUser = (username: string) =>
    prisma.user.create({
      data: {
        tenantId,
        username,
        email: `${username}@example.com`,
        displayName: username,
        status: 'active',
      },
      select: { id: true },
    });

  const admin = await createUser('cross-admin');
  const multi = await createUser('cross-multi');
  const contextOnly = await createUser('cross-context-only');
  const suspended = await createUser('cross-suspended');
  const stepper = await createUser('cross-stepper');
  const mfaUser = await createUser('cross-mfa');
  const target = await createUser('cross-target');
  const delegatedApp = await createUser('cross-delegated-app');
  const delegatedContext = await createUser('cross-delegated-context');
  const appBUserAdminUser = await createUser('cross-app-b-admin');

  const users: UserIds = {
    admin: admin.id,
    multi: multi.id,
    contextOnly: contextOnly.id,
    suspended: suspended.id,
    stepper: stepper.id,
    mfaUser: mfaUser.id,
    target: target.id,
    delegatedApp: delegatedApp.id,
    delegatedContext: delegatedContext.id,
    appBUserAdmin: appBUserAdminUser.id,
  };

  const membership = (
    clientId: string,
    userId: string,
    loginContextId: string | null,
    options: {
      status?: 'invited' | 'active' | 'suspended';
      attributes?: Record<string, unknown>;
    } = {},
  ) =>
    prisma.clientMembership.create({
      data: {
        clientId,
        userId,
        loginContextId,
        status: options.status ?? 'active',
        attributes: (options.attributes ?? {}) as never,
        joinedAt: options.status === 'invited' ? null : new Date(),
        ...(options.status === 'invited' ? { invitedAt: new Date() } : {}),
      },
    });

  await membership(appA.id, multi.id, null, { attributes: { legacy: true } });
  await membership(appA.id, multi.id, customerAdmin.id, { attributes: { companyId: 'c-42' } });
  await membership(appA.id, multi.id, customerTeam.id, { attributes: { teamId: 't-7' } });
  await membership(appB.id, multi.id, partnerPortal.id, { attributes: { partner: true } });
  await membership(appA.id, contextOnly.id, customerAdmin.id, { attributes: { dept: 'finance' } });
  await membership(appA.id, suspended.id, customerAdmin.id, { status: 'suspended' });
  await membership(appA.id, suspended.id, customerTeam.id, { attributes: { teamId: 't-8' } });
  await membership(appA.id, stepper.id, stepUp.id);
  await membership(appA.id, mfaUser.id, mfaRequired.id);
  await membership(appA.id, target.id, customerTeam.id, {
    attributes: { teamId: 't-target' },
  });
  await membership(appA.id, delegatedApp.id, null);
  await membership(appA.id, delegatedContext.id, customerAdmin.id);
  await membership(appB.id, appBUserAdminUser.id, null);

  const assign = (userId: string, roleId: string) =>
    prisma.assignment.create({
      data: {
        subjectType: 'user',
        subjectId: userId,
        roleId,
        scopeType: 'global',
        assignedBy: admin.id,
      },
    });

  for (const roleId of [
    roles.appAMember,
    roles.appAEditor,
    roles.appAManager,
    roles.appACustomerAdmin,
    roles.appBMember,
    roles.idpSuperadmin,
  ]) {
    await assign(multi.id, roleId);
  }
  for (const roleId of [roles.appAEditor, roles.appAManager, roles.appACustomerAdmin]) {
    await assign(contextOnly.id, roleId);
  }
  for (const roleId of [roles.appAEditor, roles.appAManager]) {
    await assign(suspended.id, roleId);
  }
  await assign(stepper.id, roles.appAManager);
  await assign(mfaUser.id, roles.appAMember);
  await assign(delegatedApp.id, roles.appAUserAdmin);
  await assign(delegatedContext.id, roles.appAContextAdmin);
  await assign(appBUserAdminUser.id, roles.appBUserAdmin);
  await assign(admin.id, roles.membershipAdmin);

  const permissionReader = createPrismaPermissionReader(prisma);
  const rbac = createPrismaRbacRepository(prisma);
  const audit = createPrismaAdminAudit(prisma);
  const clients = createPrismaClientRepository(prisma);
  const usersRepository = createPrismaUserRepository(prisma);
  const effectiveAccess = createPrismaEffectiveAccessSource(prisma);
  const mfaRepository = createPrismaMfaRepository(prisma, { permissions: permissionReader });

  const app = buildServer({
    issuer,
    keys,
    token: {
      clients,
      codes: createPrismaCodeRepository(prisma),
      refreshTokens: createPrismaRefreshTokenRepository(prisma),
      users: usersRepository,
      sessions: {
        async read(sid) {
          return sessions.get(sid) ?? null;
        },
      },
      access: effectiveAccess,
      contextAccess: createPrismaLoginContextAccessSource(prisma),
    },
    authorize: {
      clients,
      membershipStatus: createAuthorizeMembershipStatus(prisma),
      authenticationRequirement: createAuthorizeAuthenticationRequirement(mfaRepository),
    },
    userInfo: { users: usersRepository, access: effectiveAccess },
    adminMembers: {
      adminClientId,
      permissions: permissionReader,
      members: createPrismaMemberRepository(prisma, { rbac }),
      audit,
    },
    adminLoginContexts: {
      adminClientId,
      permissions: permissionReader,
      contexts: createPrismaLoginContextRepository(prisma),
      audit,
    },
  });
  await app.ready();

  const createSession = async (userId: string, options: SessionOptions = {}): Promise<string> => {
    const createdAt = options.authTime ?? new Date();
    const acr = options.acr ?? 'urn:on4net:acr:pwd';
    const amr = options.amr ?? ['pwd'];
    const row = await prisma.session.create({
      data: {
        userId,
        idleExpiresAt: new Date(Date.now() + 3_600_000),
        absoluteExpiresAt: new Date(Date.now() + 7_200_000),
        amr,
        acr,
        lastSeenAt: createdAt,
        createdAt,
      },
    });
    sessions.set(row.id, {
      sid: row.id,
      userId,
      createdAt: createdAt.toISOString(),
      lastSeenAt: createdAt.toISOString(),
      authTime: createdAt.toISOString(),
      idleExpiresAt: row.idleExpiresAt.toISOString(),
      absoluteExpiresAt: row.absoluteExpiresAt.toISOString(),
      amr: [...amr],
      acr,
    });
    return row.id;
  };

  const authorize = async (params: {
    clientId: AppClientId;
    sessionId?: string;
    loginContext?: string;
    prompt?: string;
    scope?: string;
    acrValues?: string;
  }): Promise<URL> => {
    const query: Record<string, string> = {
      response_type: 'code',
      client_id: params.clientId,
      redirect_uri: REDIRECT_URI[params.clientId],
      scope: params.scope ?? 'openid',
      state: 'state-1',
      nonce: 'nonce-1',
      code_challenge: s256Challenge(verifier),
      code_challenge_method: 'S256',
      ...(params.loginContext === undefined ? {} : { login_context: params.loginContext }),
      ...(params.prompt === undefined ? {} : { prompt: params.prompt }),
      ...(params.acrValues === undefined ? {} : { acr_values: params.acrValues }),
    };
    const pending = request(app.server).get('/oauth2/authorize').query(query);
    if (params.sessionId !== undefined) {
      pending.set('Cookie', `idpn_session=${params.sessionId}`);
    }
    const response = await pending;
    if (response.status !== 302) {
      throw new Error(`authorize returned ${response.status}: ${JSON.stringify(response.body)}`);
    }
    return new URL(response.headers.location as string);
  };

  const exchangeCode = async (params: {
    clientId: AppClientId;
    code: string;
    loginContext?: string;
    redirectUri?: string;
  }): Promise<request.Response> =>
    request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: params.redirectUri ?? REDIRECT_URI[params.clientId],
        client_id: params.clientId,
        code_verifier: verifier,
        ...(params.loginContext === undefined ? {} : { login_context: params.loginContext }),
      });

  const issueTokens = async (params: {
    clientId: AppClientId;
    sessionId: string;
    loginContext?: string;
    scope?: string;
  }): Promise<IssuedTokens> => {
    const location = await authorize(params);
    if (location.searchParams.get('error') !== null) {
      throw new Error(`authorize failed: ${location.searchParams.get('error') as string}`);
    }
    const code = location.searchParams.get('code');
    if (code === null) {
      throw new Error('authorize did not return a code');
    }
    const response = await exchangeCode({ ...params, code });
    if (response.status !== 200) {
      throw new Error(`token returned ${response.status}: ${JSON.stringify(response.body)}`);
    }
    return response.body as IssuedTokens;
  };

  const refresh = async (params: {
    clientId: AppClientId;
    token: string;
    loginContext?: string;
  }): Promise<request.Response> =>
    request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: params.token,
        client_id: params.clientId,
        ...(params.loginContext === undefined ? {} : { login_context: params.loginContext }),
      });

  const adminAuthorization = async (
    userId: string,
    clientId: string,
    scope = 'openid idp.client-admin',
    extra: Record<string, unknown> = {},
  ): Promise<string> => {
    const token = await keys.signAccessToken(
      { scope, client_id: clientId, auth_time: nowSeconds(), ...extra },
      { issuer, audience: clientId, subject: userId, expiresInSeconds: 300 },
    );
    return `Bearer ${token}`;
  };

  const snapshot = async (clientId: AppClientId): Promise<ClientSnapshot> => {
    const client = await prisma.client.findUniqueOrThrow({ where: { clientId } });
    const [contextRows, roleRows, membershipRows, assignmentRows, userCount] = await Promise.all([
      prisma.clientLoginContext.findMany({
        where: { clientId: client.id },
        select: {
          key: true,
          status: true,
          allowedRoles: true,
          defaultRoles: true,
          mfaPolicy: true,
          stepUpRequired: true,
          isDefault: true,
        },
        orderBy: { key: 'asc' },
      }),
      prisma.role.findMany({
        where: { clientId: client.id },
        select: {
          key: true,
          rolePermissions: { select: { permission: { select: { key: true } } } },
        },
        orderBy: { key: 'asc' },
      }),
      prisma.clientMembership.findMany({
        where: { clientId: client.id },
        select: { userId: true, loginContextId: true, status: true },
      }),
      prisma.assignment.findMany({
        where: { role: { clientId: client.id } },
        select: { subjectId: true, role: { select: { key: true } } },
      }),
      prisma.user.count(),
    ]);

    return {
      contexts: contextRows.map((row) => ({
        key: row.key,
        status: row.status,
        allowedRoles: [...row.allowedRoles].sort(),
        defaultRoles: [...row.defaultRoles].sort(),
        mfaPolicy: row.mfaPolicy,
        stepUpRequired: row.stepUpRequired,
        isDefault: row.isDefault,
      })),
      roles: roleRows.map((row) => ({
        key: row.key,
        permissions: row.rolePermissions.map((entry) => entry.permission.key).sort(),
      })),
      memberships: membershipRows
        .map((row) => ({
          userId: row.userId,
          contextId: row.loginContextId,
          status: row.status,
        }))
        .sort((left, right) =>
          `${left.userId}:${left.contextId ?? ''}`.localeCompare(
            `${right.userId}:${right.contextId ?? ''}`,
          ),
        ),
      assignments: assignmentRows
        .map((row) => ({ roleKey: row.role.key, subjectId: row.subjectId }))
        .sort((left, right) =>
          `${left.subjectId}:${left.roleKey}`.localeCompare(`${right.subjectId}:${right.roleKey}`),
        ),
      userCount,
    };
  };

  return {
    infra,
    app,
    clients: { appA: appA.id, appB: appB.id },
    roles,
    contexts,
    users,
    createSession,
    authorize,
    issueTokens,
    exchangeCode,
    refresh,
    adminAuthorization,
    verify: (token, audience = 'app-a') => keys.verify(token, { issuer, audience }),
    snapshot,
    async close() {
      await app.close();
      await infra.close();
    },
  };
}
