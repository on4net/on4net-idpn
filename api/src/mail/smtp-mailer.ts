import nodemailer from 'nodemailer';

import type { Mailer, MailMessage } from './mailer.js';

export interface SmtpMailerOptions {
  /** `smtp://host:port` or `smtps://host:port` (Mailhog locally, provider relay elsewhere). */
  url: string;
  from: string;
  /** Bounded instead of nodemailer's defaults, so a dead relay cannot pin a request. */
  connectionTimeoutMs?: number;
  greetingTimeoutMs?: number;
  socketTimeoutMs?: number;
}

/**
 * SMTP adapter backed by nodemailer. Only transport failures are reported, and only by
 * their message — a body that contains a token is never logged.
 *
 * Every timeout is bounded: without them a black-holed relay holds the caller for
 * nodemailer's defaults (up to ~2 minutes), which turned a mail outage into a request
 * outage for the invitation and resend endpoints (review finding 6 of #40).
 */
export function createSmtpMailer(options: SmtpMailerOptions): Mailer {
  const url = new URL(options.url);
  const transport = nodemailer.createTransport({
    host: url.hostname,
    port: url.port === '' ? (url.protocol === 'smtps:' ? 465 : 587) : Number(url.port),
    secure: url.protocol === 'smtps:' || url.searchParams.get('secure') === 'true',
    ...(url.username === ''
      ? {}
      : {
          auth: {
            user: decodeURIComponent(url.username),
            pass: decodeURIComponent(url.password),
          },
        }),
    connectionTimeout: options.connectionTimeoutMs ?? 10_000,
    greetingTimeout: options.greetingTimeoutMs ?? 10_000,
    socketTimeout: options.socketTimeoutMs ?? 20_000,
  });

  return {
    async send(message: MailMessage): Promise<void> {
      await transport.sendMail({
        from: options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
      });
    },
  };
}
