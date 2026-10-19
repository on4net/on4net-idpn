import type { Mailer } from '../mail/mailer.js';
import {
  buildAccountLink,
  inviteEmail,
  inviteNotificationEmail,
  passwordChangedEmail,
  passwordResetEmail,
  verificationEmail,
  type AccountLinks,
  type MailLocale,
} from './mail-templates.js';
import { issueAccountToken, type AccountTokenStore } from './tokens.js';

export interface LifecycleUser {
  id: string;
  email: string;
  displayName: string;
  locale: string;
  status: 'active' | 'pending' | 'locked' | 'disabled';
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  deletedAt: Date | null;
}

/** Persistence needed by the lifecycle flows: lookups plus email/membership activation. */
export interface LifecycleUserStore {
  findById(userId: string): Promise<LifecycleUser | null>;
  findByEmail(email: string): Promise<LifecycleUser | null>;
  markEmailVerified(userId: string, at: Date): Promise<void>;
  /** Pending users become active once the invitation is accepted. */
  activatePendingUser(userId: string, at: Date): Promise<void>;
  /** Invited memberships of the user become active when the invitation is accepted. */
  activateInvitedMemberships(userId: string, at: Date): Promise<number>;
}

export interface AccountLifecycleDependencies {
  users: LifecycleUserStore;
  tokens: AccountTokenStore;
  mailer: Mailer;
  links: AccountLinks;
  now?: () => Date;
}

export type InviteDelivery = 'invitation' | 'notification' | 'skipped';

export interface AccountLifecycle {
  readonly users: LifecycleUserStore;
  /** New users get a single-use invite link; existing users only a token-free notice. */
  sendInvite(userId: string): Promise<InviteDelivery>;
  /** Returns false when there is nothing to send (verified, disabled or missing user). */
  sendVerification(userId: string): Promise<boolean>;
  sendPasswordReset(userId: string): Promise<boolean>;
  sendPasswordChanged(userId: string): Promise<void>;
}

const EXPIRES = {
  'fa-IR': {
    invite: 'این لینک تا ۷۲ ساعت و فقط یک بار معتبر است.',
    email_verification: 'این لینک تا ۲۴ ساعت و فقط یک بار معتبر است.',
    password_reset: 'این لینک تا ۳۰ دقیقه و فقط یک بار معتبر است.',
  },
  'en-US': {
    invite: 'This link is valid for 72 hours and can be used once.',
    email_verification: 'This link is valid for 24 hours and can be used once.',
    password_reset: 'This link is valid for 30 minutes and can be used once.',
  },
} as const;

const mailLocale = (locale: string): MailLocale =>
  locale.toLowerCase().startsWith('en') ? 'en-US' : 'fa-IR';

/**
 * Orchestrates account-lifecycle mail. Tokens are issued here and only reach the transport
 * inside the message body; audit and logs never receive them.
 */
export function createAccountLifecycle(
  dependencies: AccountLifecycleDependencies,
): AccountLifecycle {
  const now = dependencies.now ?? (() => new Date());

  const sendInvitation = async (user: LifecycleUser): Promise<void> => {
    const locale = mailLocale(user.locale);
    const issued = await issueAccountToken(
      dependencies.tokens,
      { userId: user.id, purpose: 'invite' },
      now,
    );
    await dependencies.mailer.send(
      inviteEmail({
        to: user.email,
        locale,
        displayName: user.displayName,
        link: buildAccountLink(dependencies.links, 'set-password', issued.token),
        expiresIn: EXPIRES[locale].invite,
      }),
    );
  };

  return {
    users: dependencies.users,

    async sendInvite(userId) {
      const user = await dependencies.users.findById(userId);
      if (user === null || user.deletedAt !== null || user.status === 'disabled') {
        return 'skipped';
      }
      if (user.passwordHash === null) {
        await sendInvitation(user);
        return 'invitation';
      }
      await dependencies.mailer.send(
        inviteNotificationEmail({
          to: user.email,
          locale: mailLocale(user.locale),
          displayName: user.displayName,
        }),
      );
      return 'notification';
    },

    async sendVerification(userId) {
      const user = await dependencies.users.findById(userId);
      if (
        user === null ||
        user.deletedAt !== null ||
        user.status === 'disabled' ||
        user.emailVerifiedAt !== null
      ) {
        return false;
      }
      const locale = mailLocale(user.locale);
      const issued = await issueAccountToken(
        dependencies.tokens,
        { userId: user.id, purpose: 'email_verification' },
        now,
      );
      await dependencies.mailer.send(
        verificationEmail({
          to: user.email,
          locale,
          displayName: user.displayName,
          link: buildAccountLink(dependencies.links, 'verify-email', issued.token),
          expiresIn: EXPIRES[locale].email_verification,
        }),
      );
      return true;
    },

    async sendPasswordReset(userId) {
      const user = await dependencies.users.findById(userId);
      if (
        user === null ||
        user.deletedAt !== null ||
        user.status === 'disabled' ||
        user.passwordHash === null
      ) {
        return false;
      }
      const locale = mailLocale(user.locale);
      const issued = await issueAccountToken(
        dependencies.tokens,
        { userId: user.id, purpose: 'password_reset' },
        now,
      );
      await dependencies.mailer.send(
        passwordResetEmail({
          to: user.email,
          locale,
          displayName: user.displayName,
          link: buildAccountLink(dependencies.links, 'reset-password', issued.token),
          expiresIn: EXPIRES[locale].password_reset,
        }),
      );
      return true;
    },

    async sendPasswordChanged(userId) {
      const user = await dependencies.users.findById(userId);
      if (user === null || user.deletedAt !== null) {
        return;
      }
      await dependencies.mailer.send(
        passwordChangedEmail({
          to: user.email,
          locale: mailLocale(user.locale),
          displayName: user.displayName,
        }),
      );
    },
  };
}
