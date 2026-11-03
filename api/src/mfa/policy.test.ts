import { describe, expect, it } from 'vitest';

import { mfaRequirement } from './policy.js';

describe('MFA policy matrix', () => {
  it('challenges every account that has a confirmed factor', () => {
    for (const policy of ['optional', 'required_admins', 'required_all'] as const) {
      expect(mfaRequirement({ policy, hasConfirmedFactor: true, isAdmin: false })).toBe(
        'challenge',
      );
      expect(mfaRequirement({ policy, hasConfirmedFactor: true, isAdmin: true })).toBe('challenge');
    }
  });

  it('leaves optional accounts without a factor alone', () => {
    expect(mfaRequirement({ policy: 'optional', hasConfirmedFactor: false, isAdmin: false })).toBe(
      'none',
    );
    expect(mfaRequirement({ policy: 'optional', hasConfirmedFactor: false, isAdmin: true })).toBe(
      'none',
    );
  });

  it('requires enrollment for every user under required_all', () => {
    expect(
      mfaRequirement({ policy: 'required_all', hasConfirmedFactor: false, isAdmin: false }),
    ).toBe('enrollment_required');
    expect(
      mfaRequirement({ policy: 'required_all', hasConfirmedFactor: false, isAdmin: true }),
    ).toBe('enrollment_required');
  });

  it('requires enrollment only for admins under required_admins', () => {
    expect(
      mfaRequirement({ policy: 'required_admins', hasConfirmedFactor: false, isAdmin: true }),
    ).toBe('enrollment_required');
    expect(
      mfaRequirement({ policy: 'required_admins', hasConfirmedFactor: false, isAdmin: false }),
    ).toBe('none');
  });
});
