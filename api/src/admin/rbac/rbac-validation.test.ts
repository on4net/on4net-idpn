import { describe, expect, it } from 'vitest';

import {
  permissionKeyProblems,
  permissionOwnershipProblem,
  roleKeyProblems,
} from './rbac-validation.js';

describe('permissionKeyProblems', () => {
  it('accepts a key that belongs to its client', () => {
    expect(permissionKeyProblems('platform-a:contact:read', 'platform-a')).toEqual([]);
    expect(permissionKeyProblems('idp:user:read', null)).toEqual([]);
  });

  it('rejects a key that belongs to another client', () => {
    expect(permissionKeyProblems('platform-b:contact:read', 'platform-a')).toContain(
      'permission key must start with "platform-a"',
    );
    expect(permissionKeyProblems('platform-a:contact:read', null)).toContain(
      'permission key must start with "idp"',
    );
  });

  it('rejects the wrong number of segments', () => {
    expect(permissionKeyProblems('platform-a:read', 'platform-a')).toEqual([
      'permission key must have the form <clientId>:<resource>:<action>',
    ]);
    expect(permissionKeyProblems('platform-a:contact:read:extra', 'platform-a')).toHaveLength(1);
  });

  it('rejects characters that cannot appear in a key', () => {
    const problems = permissionKeyProblems('platform-a:Contact:read', 'platform-a');
    expect(problems.join(' ')).toContain('lowercase letters');
  });

  it('rejects an empty or oversized key', () => {
    expect(permissionKeyProblems('', 'platform-a')).toHaveLength(1);
    expect(permissionKeyProblems(`platform-a:${'a'.repeat(200)}:read`, 'platform-a')).toHaveLength(
      1,
    );
  });
});

describe('roleKeyProblems', () => {
  it('accepts client and global role keys', () => {
    expect(roleKeyProblems('platform-a:member', 'platform-a')).toEqual([]);
    expect(roleKeyProblems('idp:superadmin', null)).toEqual([]);
  });

  it('rejects a key from another client and malformed keys', () => {
    expect(roleKeyProblems('platform-b:member', 'platform-a')).toContain(
      'role key must start with "platform-a"',
    );
    expect(roleKeyProblems('platform-a:member:extra', 'platform-a')).toEqual([
      'role key must have the form <clientId>:<role>',
    ]);
  });
});

describe('permissionOwnershipProblem', () => {
  it('allows own-client and global permissions', () => {
    expect(permissionOwnershipProblem('platform-a', 'platform-a')).toBeNull();
    expect(permissionOwnershipProblem(null, 'platform-a')).toBeNull();
    expect(permissionOwnershipProblem(null, null)).toBeNull();
  });

  it('rejects a permission owned by a different client', () => {
    expect(permissionOwnershipProblem('platform-a', 'platform-b')).toContain(
      'cannot be linked to a role of client "platform-b"',
    );
  });
});
