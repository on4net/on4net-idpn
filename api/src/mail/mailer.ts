/**
 * Transactional mail port (docs/auth-flows.md 8, docs/setup.md).
 *
 * Adapters must never log the message body: invite, verification and reset bodies contain
 * single-use tokens.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Stable key for providers that support de-duplication; never part of the body. */
  idempotencyKey?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}
