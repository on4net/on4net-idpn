import nodemailer from 'nodemailer';

import type { Mailer, MailMessage } from './mailer.js';

export interface SmtpMailerOptions {
  /** `smtp://host:port` or `smtps://host:port` (Mailhog locally, provider relay elsewhere). */
  url: string;
  from: string;
}

/**
 * SMTP adapter backed by nodemailer. Only transport failures are reported, and only by
 * their message — a body that contains a token is never logged.
 */
export function createSmtpMailer(options: SmtpMailerOptions): Mailer {
  const transport = nodemailer.createTransport(options.url);

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
