import type { Mailer, MailMessage } from './mailer.js';

/**
 * Test/dev adapter that records messages instead of delivering them.
 * Assertions read `sent` so integration tests never depend on a real SMTP server.
 */
export class RecordingMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    // Copy the message so later mutation by a caller cannot rewrite recorded evidence.
    this.sent.push({ ...message });
  }

  clear(): void {
    this.sent.length = 0;
  }

  lastTo(recipient: string): MailMessage | undefined {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      const message = this.sent[index];
      if (message?.to === recipient) {
        return message;
      }
    }
    return undefined;
  }
}

/** Used when `SMTP_URL` is unset: the flow succeeds but no mail leaves the process. */
export class NullMailer implements Mailer {
  async send(_message: MailMessage): Promise<void> {
    // Intentionally empty.
  }
}
