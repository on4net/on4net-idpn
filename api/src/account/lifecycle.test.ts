import { describe, expect, it } from 'vitest';

import { RecordingMailer } from '../mail/recording-mailer.js';
import {
  buildAccountLink,
  inviteEmail,
  inviteNotificationEmail,
  passwordChangedEmail,
  passwordResetEmail,
  verificationEmail,
} from './mail-templates.js';
import {
  createAccountLifecycle,
  type LifecycleUser,
  type LifecycleUserStore,
} from './lifecycle.js';
import type { AccountTokenStore } from './tokens.js';

const at = new Date('2026-10-19T10:00:00.000Z');

const user = (overrides: Partial<LifecycleUser> = {}): LifecycleUser => ({
  id: 'user-1',
  email: 'sara@example.com',
  displayName: 'سارا محمدی',
  locale: 'fa-IR',
  status: 'pending',
  passwordHash: null,
  emailVerifiedAt: null,
  deletedAt: null,
  ...overrides,
});

function fakeUsers(records: LifecycleUser[]): LifecycleUserStore & {
  verified: string[];
  activated: string[];
} {
  const verified: string[] = [];
  const activated: string[] = [];
  return {
    verified,
    activated,
    async findById(userId) {
      return records.find((record) => record.id === userId) ?? null;
    },
    async findByEmail(email) {
      return records.find((record) => record.email === email) ?? null;
    },
    async markEmailVerified(userId) {
      verified.push(userId);
    },
    async activatePendingUser(userId) {
      activated.push(userId);
    },
    async activateInvitedMemberships(userId) {
      activated.push(userId);
      return 1;
    },
  };
}

function fakeTokens(): AccountTokenStore {
  return {
    async create() {
      // No persistence needed: the mail body is the observable output.
    },
    async invalidateActive() {
      return 0;
    },
    async findByHash() {
      return null;
    },
    async consume() {
      return { ok: false, reason: 'invalid' };
    },
  };
}

describe('account mail templates', () => {
  it('builds a Hosted UI link with only the action and token in the query', () => {
    const link = buildAccountLink(
      { uiBaseUrl: 'https://auth.example.com/app/' },
      'reset-password',
      'token-value',
    );
    const url = new URL(link);

    expect(url.origin).toBe('https://auth.example.com');
    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('action')).toBe('reset-password');
    expect(url.searchParams.get('token')).toBe('token-value');
  });

  it('puts the single-use token in the body, never in the subject', () => {
    const message = passwordResetEmail({
      to: 'sara@example.com',
      locale: 'en-US',
      displayName: 'Sara',
      link: 'https://auth.example.com/?action=reset-password&token=secret-token',
      expiresIn: 'This link is valid for 30 minutes.',
    });

    expect(message.subject).toBe('Reset your password');
    expect(message.text).toContain('secret-token');
    expect(message.text).toContain('30 minutes');
    expect(message.subject).not.toContain('secret-token');
  });

  it('escapes display names in HTML', () => {
    const message = inviteEmail({
      to: 'sara@example.com',
      locale: 'en-US',
      displayName: '<script>alert(1)</script>',
      link: 'https://auth.example.com/?token=1',
      expiresIn: '72 hours',
    });

    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });

  it('localizes verification, invite notification and password-changed mail', () => {
    expect(
      verificationEmail({
        to: 'sara@example.com',
        locale: 'fa-IR',
        displayName: 'سارا',
        link: 'https://auth.example.com/?token=1',
        expiresIn: '۲۴ ساعت',
      }).subject,
    ).toBe('تأیید ایمیل');

    const notice = inviteNotificationEmail({
      to: 'sara@example.com',
      locale: 'en-US',
      displayName: 'Sara',
    });
    expect(notice.subject).toBe('You were added to an application');
    expect(JSON.stringify(notice)).not.toMatch(/token|https?:/);

    expect(
      passwordChangedEmail({ to: 'sara@example.com', locale: 'fa-IR', displayName: 'سارا' })
        .subject,
    ).toBe('رمز عبور شما تغییر کرد');
  });
});

describe('account lifecycle delivery', () => {
  it('emails an invite link only for a user without a password', async () => {
    const mailer = new RecordingMailer();
    const users = fakeUsers([user()]);
    const lifecycle = createAccountLifecycle({
      users,
      tokens: fakeTokens(),
      mailer,
      links: { uiBaseUrl: 'https://auth.example.com' },
      now: () => at,
    });

    await expect(lifecycle.sendInvite('user-1')).resolves.toBe('invitation');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.subject).toBe('دعوت‌نامه');
    expect(mailer.sent[0]?.text).toContain('action=set-password');
    expect(mailer.sent[0]?.text).toContain('token=');
  });

  it('sends an existing user a notification without a token', async () => {
    const mailer = new RecordingMailer();
    const lifecycle = createAccountLifecycle({
      users: fakeUsers([user({ passwordHash: 'argon2-hash' })]),
      tokens: fakeTokens(),
      mailer,
      links: { uiBaseUrl: 'https://auth.example.com' },
    });

    await expect(lifecycle.sendInvite('user-1')).resolves.toBe('notification');
    expect(mailer.sent).toHaveLength(1);
    expect(JSON.stringify(mailer.sent[0])).not.toMatch(/token=|https?:/);
  });

  it('skips disabled and deleted users', async () => {
    const mailer = new RecordingMailer();
    const lifecycle = createAccountLifecycle({
      users: fakeUsers([
        user({ id: 'disabled', status: 'disabled' }),
        user({ id: 'deleted', deletedAt: at }),
      ]),
      tokens: fakeTokens(),
      mailer,
      links: { uiBaseUrl: 'https://auth.example.com' },
    });

    await expect(lifecycle.sendInvite('disabled')).resolves.toBe('skipped');
    await expect(lifecycle.sendInvite('deleted')).resolves.toBe('skipped');
    await expect(lifecycle.sendPasswordReset('deleted')).resolves.toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });

  it('does not resend verification for an already verified address', async () => {
    const mailer = new RecordingMailer();
    const lifecycle = createAccountLifecycle({
      users: fakeUsers([user({ status: 'active', emailVerifiedAt: at })]),
      tokens: fakeTokens(),
      mailer,
      links: { uiBaseUrl: 'https://auth.example.com' },
    });

    await expect(lifecycle.sendVerification('user-1')).resolves.toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });

  it('sends a reset link for an active account and a change notice', async () => {
    const mailer = new RecordingMailer();
    const lifecycle = createAccountLifecycle({
      users: fakeUsers([user({ status: 'active', passwordHash: 'argon2-hash' })]),
      tokens: fakeTokens(),
      mailer,
      links: { uiBaseUrl: 'https://auth.example.com' },
    });

    await expect(lifecycle.sendPasswordReset('user-1')).resolves.toBe(true);
    await lifecycle.sendPasswordChanged('user-1');
    expect(mailer.sent.map((message) => message.subject)).toEqual([
      'بازنشانی رمز عبور',
      'رمز عبور شما تغییر کرد',
    ]);
    expect(mailer.sent[0]?.text).toContain('action=reset-password');
  });

  it('does not send a reset link to a user without a password', async () => {
    const mailer = new RecordingMailer();
    const lifecycle = createAccountLifecycle({
      users: fakeUsers([user()]),
      tokens: fakeTokens(),
      mailer,
      links: { uiBaseUrl: 'https://auth.example.com' },
    });

    await expect(lifecycle.sendPasswordReset('user-1')).resolves.toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });
});
