import type { ServerEnv } from '@idpn/config';

import type { Mailer } from './mailer.js';
import { NullMailer } from './recording-mailer.js';
import { createSmtpMailer } from './smtp-mailer.js';

/**
 * Selects the mail adapter from configuration. Local development points `SMTP_URL` at
 * Mailhog (compose.yaml); tests inject a RecordingMailer; without SMTP the API stays usable
 * (flows return the same responses) but no message is delivered.
 */
export function createMailer(env: Pick<ServerEnv, 'SMTP_URL' | 'MAIL_FROM'>): Mailer {
  if (env.SMTP_URL === undefined) {
    return new NullMailer();
  }
  return createSmtpMailer({ url: env.SMTP_URL, from: env.MAIL_FROM });
}
