import { describe, expect, it } from 'vitest';

import { contextRoleProblems, validateMembershipAttributes } from './member-validation.js';

const schema = {
  type: 'object',
  properties: {
    department: { type: 'string' },
    seats: { type: 'integer' },
    active: { type: 'boolean' },
  },
  required: ['department'],
  additionalProperties: false,
};

describe('validateMembershipAttributes', () => {
  it('accepts attributes that satisfy the schema', () => {
    expect(validateMembershipAttributes(schema, { department: 'sales', seats: 3 })).toEqual([]);
  });

  it('requires an object', () => {
    expect(validateMembershipAttributes(schema, null)).toEqual(['attributes must be an object']);
    expect(validateMembershipAttributes(schema, ['sales'])).toEqual([
      'attributes must be an object',
    ]);
  });

  it('accepts any object when the client has no schema', () => {
    expect(validateMembershipAttributes(null, { anything: true })).toEqual([]);
  });

  it('rejects a missing required property', () => {
    expect(validateMembershipAttributes(schema, { seats: 1 })).toEqual([
      'attributes.department is required',
    ]);
  });

  it('rejects unknown properties when additionalProperties is false', () => {
    expect(validateMembershipAttributes(schema, { department: 'sales', extra: 1 })).toEqual([
      'attributes.extra is not allowed',
    ]);
  });

  it('rejects a value with the wrong type', () => {
    expect(validateMembershipAttributes(schema, { department: 7 })).toEqual([
      'attributes.department must be of type string',
    ]);
    expect(validateMembershipAttributes(schema, { department: 'sales', seats: 1.5 })).toEqual([
      'attributes.seats must be of type integer',
    ]);
  });

  it('fails closed for an unreadable schema', () => {
    expect(validateMembershipAttributes({ type: 'array' }, {})).toEqual([
      'membership schema must describe an object',
    ]);
    expect(validateMembershipAttributes({ properties: [] }, {})).toEqual([
      'membership schema properties must be an object',
    ]);
    expect(
      validateMembershipAttributes(
        { properties: { department: { type: 'date' } } },
        {
          department: 'x',
        },
      ),
    ).toEqual(['attributes.department has an unsupported type in the membership schema']);
  });
});

describe('contextRoleProblems', () => {
  it('accepts roles that the context allows', () => {
    expect(
      contextRoleProblems(['app-a:customer-admin'], ['app-a:customer-admin', 'app-a:member']),
    ).toEqual([]);
  });

  it('accepts an empty role set', () => {
    expect(contextRoleProblems([], ['app-a:member'])).toEqual([]);
  });

  it('rejects a role outside allowed_roles', () => {
    expect(contextRoleProblems(['app-a:manager'], ['app-a:member'])).toEqual([
      'role "app-a:manager" is not allowed in this login context',
    ]);
  });

  it('rejects every role when the context allows none', () => {
    expect(contextRoleProblems(['app-a:member', 'app-a:invoice'], [])).toEqual([
      'role "app-a:invoice" is not allowed in this login context',
      'role "app-a:member" is not allowed in this login context',
    ]);
  });

  it('reports a disallowed role once even when it is repeated', () => {
    expect(contextRoleProblems(['app-a:manager', 'app-a:manager'], ['app-a:member'])).toEqual([
      'role "app-a:manager" is not allowed in this login context',
    ]);
  });

  it('never accepts a global idp role through a context', () => {
    expect(contextRoleProblems(['idp:superadmin'], ['app-a:member'])).toEqual([
      'role "idp:superadmin" is not allowed in this login context',
    ]);
  });
});
