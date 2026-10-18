import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../src/generated/prisma/client.js';
import { buildPublicClientConfig, type PublicClientSource } from '../src/public-config/build.js';
import { createPrismaPublicConfigRepository } from '../src/public-config/prisma-repository.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const deps = {
  translationsUrl: 'https://auth.example.com/api/v1/clients/app-a/translations/bundle',
  mfe: { version: '1.0.0', remoteEntry: 'https://cdn.example.com/idpn-mfe/1.0.0/remoteEntry.js' },
};

const source: PublicClientSource = {
  clientId: 'app-a',
  name: 'App A',
  status: 'active',
  locales: { default: 'fa-IR', supported: ['fa-IR', 'en-US'], version: 'v1' },
  branding: {
    logoUrl: 'https://app-a.example.com/logo.svg',
    primaryColor: '#0f766e',
    radius: '8px',
  },
  registrationPolicy: 'invite_only',
  mfaPolicy: 'required_admins',
  defaultLoginContextKey: 'customer-team',
  mfeFeatures: { userManagement: true },
  loginContexts: [
    {
      key: 'customer-admin',
      name: 'مدیر مشتری',
      description: 'مدیریت کاربران',
      methods: ['password', 'google', 'unknown-method'],
      mfaPolicy: 'required_all',
    },
  ],
  socialProviders: [
    { provider: 'google', label: 'Google' },
    { provider: 'facebook', label: 'Facebook' },
  ],
};

describe('buildPublicClientConfig', () => {
  it('maps the client row to the public contract', () => {
    const config = buildPublicClientConfig(source, deps);

    expect(config).toMatchObject({
      clientId: 'app-a',
      locale: 'fa-IR',
      defaultLoginContext: 'customer-team',
      theme: { primary: '#0f766e', radius: '8px' },
      features: { userManagement: true, selfServiceRegistration: false, mfa: true },
      mfe: deps.mfe,
    });
    expect(config.locales.dir).toEqual({ 'fa-IR': 'rtl', 'en-US': 'ltr' });
    expect(config.loginContexts[0]?.methods).toEqual(['password', 'google']);
    expect(config.socialProviders).toEqual([
      { provider: 'google', label: 'Google' },
      { provider: 'facebook', label: 'Facebook' },
    ]);
  });

  it('never exposes secrets, redirect URIs or role lists', () => {
    const serialized = JSON.stringify(buildPublicClientConfig(source, deps));

    for (const forbidden of ['secret', 'redirect', 'allowedRoles', 'clientSecret', 'privateKey']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('falls back safely for missing locale and branding data', () => {
    const minimal: PublicClientSource = {
      ...source,
      locales: {},
      branding: {},
      defaultLoginContextKey: null,
      loginContexts: [],
      socialProviders: [],
      mfeFeatures: {},
    };

    const config = buildPublicClientConfig(minimal, deps);
    expect(config.locale).toBe('fa-IR');
    expect(config.locales.dir['fa-IR']).toBe('rtl');
    expect(config.theme).toEqual({});
    expect(config.defaultLoginContext).toBeUndefined();
  });
});

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let prisma: PrismaClient;
let connectionString: string;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString },
  });
}

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_pub_${Date.now()}`;
    serverClient = new Client({ connectionString: external });
    await serverClient.connect();
    await serverClient.query(`CREATE DATABASE "${scratchDatabase}"`);
    const url = new URL(external);
    url.pathname = `/${scratchDatabase}`;
    connectionString = url.toString();
  } else {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(180_000)
      .start();
    connectionString = container.getConnectionUri();
  }
  await migrateDeploy();
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}, 300_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
});

describe('Prisma public config repository', () => {
  it('reads only active login contexts and enabled social providers', async () => {
    const tenant = await prisma.tenant.create({
      data: { slug: `pub-${Date.now()}`, name: 'Public tenant' },
    });
    const client = await prisma.client.create({
      data: {
        clientId: `pub-client-${Date.now()}`,
        name: 'Public client',
        type: 'web',
        redirectUris: ['https://pub.example.com/cb'],
        postLogoutRedirectUris: ['https://pub.example.com/'],
        allowedOrigins: ['https://pub.example.com'],
        scopes: ['openid', 'profile', 'email'],
        allowedEmailDomains: [],
        tenantId: tenant.id,
        locales: { default: 'fa-IR', supported: ['fa-IR', 'en-US'] },
        branding: { logoUrl: 'https://pub.example.com/logo.svg', primaryColor: '#112233' },
        mfeFeatures: { userManagement: true, selfServiceRegistration: false },
        registrationPolicy: 'invite_only',
        mfaPolicy: 'required_admins',
        defaultLoginContextKey: 'team',
        loginContexts: {
          create: [
            {
              key: 'team',
              name: 'Team',
              status: 'active',
              isDefault: true,
              allowedRoles: [],
              defaultRoles: [],
              loginMethods: ['password', 'google'],
              mfaPolicy: 'optional',
              registrationPolicy: 'invite_only',
              allowedEmailDomains: [],
              sessionIdleTtl: 1800,
              sessionAbsoluteTtl: 28800,
            },
            {
              key: 'legacy',
              name: 'Legacy',
              status: 'disabled',
              allowedRoles: [],
              defaultRoles: [],
              loginMethods: ['password'],
              mfaPolicy: 'optional',
              registrationPolicy: 'disabled',
              allowedEmailDomains: [],
              sessionIdleTtl: 1800,
              sessionAbsoluteTtl: 28800,
            },
          ],
        },
        socialProviders: {
          create: [
            {
              provider: 'google',
              clientKey: 'google-key',
              clientSecretEncrypted: Buffer.from('secret'),
              scopes: ['openid'],
              allowedEmailDomains: [],
              enabled: true,
            },
            {
              provider: 'facebook',
              clientKey: 'facebook-key',
              clientSecretEncrypted: Buffer.from('secret'),
              scopes: ['openid'],
              allowedEmailDomains: [],
              enabled: false,
            },
          ],
        },
      },
    });

    const repository = createPrismaPublicConfigRepository(prisma);
    const loaded = await repository.findPublicClient(client.clientId);

    expect(loaded).not.toBeNull();
    expect(loaded?.loginContexts.map((context) => context.key)).toEqual(['team']);
    expect(loaded?.socialProviders).toEqual([{ provider: 'google', label: 'Google' }]);

    const config = buildPublicClientConfig(loaded as PublicClientSource, deps);
    expect(config).toMatchObject({ clientId: client.clientId, defaultLoginContext: 'team' });
    expect(JSON.stringify(config)).not.toContain('https://pub.example.com/cb');
    expect(JSON.stringify(config)).not.toContain('secret');

    const missing = await repository.findPublicClient('does-not-exist');
    expect(missing).toBeNull();
  }, 60_000);
});
