import type { MailMessage } from '../mail/mailer.js';

export type MailLocale = 'fa-IR' | 'en-US';

export interface AccountLinks {
  /** Hosted UI base (`HOSTED_UI_URL` or `APP_URL`); links always point at the UI. */
  uiBaseUrl: string;
}

export type AccountLinkAction = 'set-password' | 'reset-password' | 'verify-email';

/**
 * Builds a Hosted UI link. The token is only in the fragment-free query string of a link
 * that is emailed once; it is never logged by this module.
 */
export function buildAccountLink(
  links: AccountLinks,
  action: AccountLinkAction,
  token: string,
): string {
  const url = new URL('/', links.uiBaseUrl);
  url.searchParams.set('action', action);
  url.searchParams.set('token', token);
  return url.toString();
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface TemplateInput {
  to: string;
  locale: MailLocale;
  displayName: string;
  link: string;
  expiresIn: string;
}

const greeting = (locale: MailLocale, name: string): string =>
  locale === 'en-US' ? `Hello ${name},` : `${name} عزیز،`;

const closing = (locale: MailLocale): string =>
  locale === 'en-US'
    ? 'If you did not expect this message, you can ignore it.'
    : 'اگر این پیام را انتظار نداشتید، می‌توانید آن را نادیده بگیرید.';

function transactionalMessage(input: {
  to: string;
  subject: string;
  lead: string;
  action: string;
  link: string;
  expiresIn: string;
  locale: MailLocale;
  displayName: string;
}): MailMessage {
  const text = [
    greeting(input.locale, input.displayName),
    '',
    input.lead,
    '',
    `${input.action}: ${input.link}`,
    '',
    input.expiresIn,
    closing(input.locale),
  ].join('\n');
  const html = [
    `<p>${escapeHtml(greeting(input.locale, input.displayName))}</p>`,
    `<p>${escapeHtml(input.lead)}</p>`,
    `<p><a href="${escapeHtml(input.link)}">${escapeHtml(input.action)}</a></p>`,
    `<p>${escapeHtml(input.expiresIn)}</p>`,
    `<p>${escapeHtml(closing(input.locale))}</p>`,
  ].join('\n');
  return { to: input.to, subject: input.subject, text, html };
}

export function inviteEmail(input: TemplateInput): MailMessage {
  const english = input.locale === 'en-US';
  return transactionalMessage({
    ...input,
    subject: english ? 'You are invited' : 'دعوت‌نامه',
    lead: english
      ? 'You have been invited. Set your password to activate your account.'
      : 'شما دعوت شده‌اید. برای فعال‌سازی حساب، رمز عبور خود را تعیین کنید.',
    action: english ? 'Set your password' : 'تعیین رمز عبور',
  });
}

export function inviteNotificationEmail(
  input: Omit<TemplateInput, 'link' | 'expiresIn'>,
): MailMessage {
  const english = input.locale === 'en-US';
  return {
    to: input.to,
    subject: english ? 'You were added to an application' : 'افزودن به یک اپلیکیشن',
    text: english
      ? `${greeting(input.locale, input.displayName)}\n\nYou were added to an application. Sign in with your existing account to continue.\n\n${closing(input.locale)}`
      : `${greeting(input.locale, input.displayName)}\n\nشما به یک اپلیکیشن افزوده شدید. با حساب موجود خود وارد شوید.\n\n${closing(input.locale)}`,
  };
}

export function verificationEmail(input: TemplateInput): MailMessage {
  const english = input.locale === 'en-US';
  return transactionalMessage({
    ...input,
    subject: english ? 'Verify your email address' : 'تأیید ایمیل',
    lead: english
      ? 'Confirm your email address to finish securing your account.'
      : 'برای تکمیل امنیت حساب، ایمیل خود را تأیید کنید.',
    action: english ? 'Verify email' : 'تأیید ایمیل',
  });
}

export function passwordResetEmail(input: TemplateInput): MailMessage {
  const english = input.locale === 'en-US';
  return transactionalMessage({
    ...input,
    subject: english ? 'Reset your password' : 'بازنشانی رمز عبور',
    lead: english
      ? 'A password reset was requested for your account. Choose a new password below.'
      : 'درخواست بازنشانی رمز عبور برای حساب شما ثبت شده است. رمز جدید را از طریق لینک زیر تعیین کنید.',
    action: english ? 'Reset password' : 'بازنشانی رمز عبور',
  });
}

export function passwordChangedEmail(input: {
  to: string;
  locale: MailLocale;
  displayName: string;
}): MailMessage {
  const english = input.locale === 'en-US';
  return {
    to: input.to,
    subject: english ? 'Your password was changed' : 'رمز عبور شما تغییر کرد',
    text: english
      ? `${greeting(input.locale, input.displayName)}\n\nYour password was changed and every session was signed out.\n\n${closing(input.locale)}`
      : `${greeting(input.locale, input.displayName)}\n\nرمز عبور شما تغییر کرد و همه نشست‌ها بسته شدند.\n\n${closing(input.locale)}`,
  };
}
