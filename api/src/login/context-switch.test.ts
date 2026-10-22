import { describe, expect, it } from 'vitest';

import {
  evaluateContextSwitch,
  type ContextSwitchTarget,
  type MembershipStatus,
} from './context-switch.js';
import { sessionProvesMultiFactor } from '../mfa/policy.js';

const now = new Date('2026-10-19T12:00:00.000Z');

const passwordSession = {
  loginContext: 'customer-admin',
  amr: ['pwd'],
  acr: 'urn:on4net:acr:pwd',
  authTime: new Date('2026-10-19T11:59:00.000Z'),
};

const mfaSession = {
  ...passwordSession,
  amr: ['pwd', 'totp'],
  acr: 'urn:on4net:acr:mfa',
};

const context = (overrides: Partial<ContextSwitchTarget> = {}): ContextSwitchTarget => ({
  id: 'context-1',
  key: 'customer-team',
  name: 'Customer team',
  status: 'active',
  mfaPolicy: 'optional',
  stepUpRequired: false,
  ...overrides,
});

const evaluate = (
  input: {
    session?: typeof passwordSession;
    target?: ContextSwitchTarget;
    membership?: MembershipStatus | null;
    adminScoped?: boolean;
    at?: Date;
  } = {},
) =>
  evaluateContextSwitch({
    session: input.session ?? passwordSession,
    target: input.target ?? context(),
    membership: input.membership === undefined ? 'active' : input.membership,
    adminScoped: input.adminScoped ?? false,
    now: input.at ?? now,
  });

describe('sessionProvesMultiFactor', () => {
  it('accepts the MFA acr or a second-factor amr and rejects a password-only session', () => {
    expect(sessionProvesMultiFactor(mfaSession)).toBe(true);
    expect(sessionProvesMultiFactor({ acr: 'urn:on4net:acr:pwd', amr: ['pwd', 'webauthn'] })).toBe(
      true,
    );
    expect(sessionProvesMultiFactor(passwordSession)).toBe(false);
    expect(sessionProvesMultiFactor({ acr: 'urn:on4net:acr:pwd', amr: ['pwd'] })).toBe(false);
  });
});

describe('evaluateContextSwitch', () => {
  it('allows a switch to an optional context with an active membership', () => {
    expect(evaluate()).toEqual({ ok: true });
  });

  it('refuses a disabled context even when the membership is active', () => {
    expect(evaluate({ target: context({ status: 'disabled' }) })).toEqual({
      ok: false,
      reason: 'context_disabled',
    });
  });

  it('refuses a context where the user has no membership or only an invitation', () => {
    expect(evaluate({ membership: null })).toEqual({
      ok: false,
      reason: 'membership_required',
    });
    expect(evaluate({ membership: 'invited' })).toEqual({
      ok: false,
      reason: 'membership_required',
    });
  });

  it('refuses a suspended context membership before any policy decision', () => {
    expect(evaluate({ membership: 'suspended' })).toEqual({
      ok: false,
      reason: 'membership_suspended',
    });
  });

  it('reports already_in_context only for a context the user may legitimately use', () => {
    expect(evaluate({ target: context({ key: 'customer-admin' }) })).toEqual({
      ok: false,
      reason: 'already_in_context',
    });
    expect(
      evaluate({ target: context({ key: 'customer-admin' }), membership: 'suspended' }),
    ).toEqual({ ok: false, reason: 'membership_suspended' });
  });

  it('refuses a step-up context for a password-only session', () => {
    expect(evaluate({ target: context({ stepUpRequired: true }) })).toEqual({
      ok: false,
      reason: 'interaction_required',
    });
  });

  it('refuses a step-up context even with MFA when the authentication is stale', () => {
    const stale = {
      ...mfaSession,
      authTime: new Date(now.getTime() - 301_000),
    };
    expect(evaluate({ session: stale, target: context({ stepUpRequired: true }) })).toEqual({
      ok: false,
      reason: 'interaction_required',
    });
  });

  it('allows a step-up context with a fresh multi-factor authentication', () => {
    expect(evaluate({ session: mfaSession, target: context({ stepUpRequired: true }) })).toEqual({
      ok: true,
    });
  });

  it('enforces required_all without downgrading to a password-only session', () => {
    const target = context({ mfaPolicy: 'required_all' });
    expect(evaluate({ target })).toEqual({ ok: false, reason: 'interaction_required' });
    expect(evaluate({ session: mfaSession, target })).toEqual({ ok: true });
  });

  it('requires MFA for required_admins only when the user administers the app', () => {
    const target = context({ mfaPolicy: 'required_admins' });
    expect(evaluate({ target, adminScoped: false })).toEqual({ ok: true });
    expect(evaluate({ target, adminScoped: true })).toEqual({
      ok: false,
      reason: 'interaction_required',
    });
    expect(evaluate({ session: mfaSession, target, adminScoped: true })).toEqual({ ok: true });
  });
});
