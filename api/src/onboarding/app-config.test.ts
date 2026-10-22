import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseAppOnboardingConfig } from './app-config.js';
import { planPermissionMapping } from './permission-mapping.js';

const baseConfig = {
  clientId: 'platform-a',
  permissions: [
    { key: 'platform-a:contact:read', description: 'Read contacts' },
    { key: 'platform-a:contact:write', description: 'Write contacts' },
  ],
  roles: [
    {
      key: 'platform-a:member',
      name: 'Member',
      description: 'Default member',
      permissions: ['platform-a:contact:read'],
    },
    {
      key: 'platform-a:user-admin',
      name: 'User administrator',
      description: 'Delegated administration',
      permissions: ['idp:client-member:read', 'idp:client-member:invite'],
    },
  ],
  defaultRole: 'platform-a:member',
  userAdminRole: 'platform-a:user-admin',
};

const plan = (config: unknown) => {
  const parsed = parseAppOnboardingConfig(config);
  expect(parsed.problems).toEqual([]);
  expect(parsed.config).not.toBeNull();
  return planPermissionMapping(parsed.config!);
};

describe('app onboarding config', () => {
  it('applies documented defaults for social providers', () => {
    const parsed = parseAppOnboardingConfig({
      ...baseConfig,
      socialProviders: { google: {} },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.config?.socialProviders.google).toEqual({
      enabled: true,
      scopes: ['openid', 'email', 'profile'],
      allowedEmailDomains: [],
    });
  });

  it('rejects an unknown field instead of ignoring a typo', () => {
    const parsed = parseAppOnboardingConfig({ ...baseConfig, defaultRoles: 'platform-a:member' });
    expect(parsed.ok).toBe(false);
    expect(parsed.problems.join(' ')).toContain('defaultRoles');
  });

  it('rejects an invalid client id and an unknown provider', () => {
    const parsed = parseAppOnboardingConfig({
      ...baseConfig,
      clientId: 'Platform A',
      socialProviders: { github: {} },
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.problems.join(' ')).toContain('clientId');
    expect(parsed.problems.join(' ')).toContain('socialProviders');
  });

  it('rejects a credential value passed instead of an env variable name', () => {
    const parsed = parseAppOnboardingConfig({
      ...baseConfig,
      socialProviders: { google: { clientSecretRef: 'GOCSPX-super-secret' } },
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.problems.join(' ')).toContain('clientSecretRef');
  });
});

describe('permission mapping validation', () => {
  it('marks exactly the configured default role', () => {
    const result = plan(baseConfig);
    expect(result.ok).toBe(true);
    expect(result.plan?.roles.filter((role) => role.isDefault).map((role) => role.key)).toEqual([
      'platform-a:member',
    ]);
    expect(result.plan?.defaultRoleKey).toBe('platform-a:member');
    expect(result.plan?.userAdminRoleKey).toBe('platform-a:user-admin');
  });

  it('rejects a permission owned by another client', () => {
    const result = plan({
      ...baseConfig,
      permissions: [{ key: 'platform-b:contact:read', description: 'Read' }],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('must start with "platform-a"');
  });

  it('rejects a role key that is not owned by the app', () => {
    const result = plan({
      ...baseConfig,
      roles: [
        { key: 'idp:superadmin', name: 'Root', description: 'Root', permissions: [] },
        ...baseConfig.roles,
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('must start with "platform-a"');
  });

  it('rejects linking an undeclared or privileged permission to a role', () => {
    const result = plan({
      ...baseConfig,
      roles: [
        { ...baseConfig.roles[0]!, permissions: ['platform-a:contact:delete'] },
        { ...baseConfig.roles[1]!, permissions: ['idp:superadmin'] },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('platform-a:contact:delete');
    expect(result.problems.join(' ')).toContain('idp:superadmin');
  });

  it('requires a declared default role and a distinct user-admin role', () => {
    const result = plan({ ...baseConfig, defaultRole: 'platform-a:owner' });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('defaultRole "platform-a:owner" is not declared');

    const same = plan({ ...baseConfig, userAdminRole: 'platform-a:member' });
    expect(same.ok).toBe(false);
    expect(same.problems.join(' ')).toContain('must be different');
  });

  it('rejects duplicate declarations', () => {
    const result = plan({
      ...baseConfig,
      permissions: [
        { key: 'platform-a:contact:read', description: 'Read' },
        { key: 'platform-a:contact:read', description: 'Read again' },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('declared more than once');
  });
});

describe('committed examples', () => {
  it.each(['platform-a', 'platform-b'])('keeps examples/onboarding/%s.json valid', async (name) => {
    const content = await readFile(
      new URL(`../../../examples/onboarding/${name}.json`, import.meta.url),
      'utf8',
    );
    const parsed = parseAppOnboardingConfig(JSON.parse(content) as unknown);
    expect(parsed.problems).toEqual([]);
    const mapping = planPermissionMapping(parsed.config!);
    expect(mapping.problems).toEqual([]);
    expect(mapping.plan?.roles.some((role) => role.isDefault)).toBe(true);
  });
});
