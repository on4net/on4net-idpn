import { describe, expect, it, vi } from 'vitest';

const createTransport = vi.fn(() => ({ sendMail: vi.fn().mockResolvedValue({}) }));

vi.mock('nodemailer', () => ({ default: { createTransport } }));

const { createSmtpMailer } = await import('./smtp-mailer.js');

describe('createSmtpMailer', () => {
  it('bounds every SMTP timeout so a dead relay cannot hold a request', () => {
    createSmtpMailer({ url: 'smtp://relay.example.com:25', from: 'no-reply@example.com' });

    expect(createTransport).toHaveBeenCalledWith({
      host: 'relay.example.com',
      port: 25,
      secure: false,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  });

  it('keeps credentials from the URL and defaults a secure port', () => {
    createSmtpMailer({
      url: 'smtps://user:p%40ss@relay.example.com',
      from: 'no-reply@example.com',
    });

    expect(createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: 'relay.example.com',
        port: 465,
        secure: true,
        auth: { user: 'user', pass: 'p@ss' },
      }),
    );
  });

  it('lets a deployment override the bounds', () => {
    createSmtpMailer({
      url: 'smtps://relay.example.com:465',
      from: 'no-reply@example.com',
      connectionTimeoutMs: 2000,
      greetingTimeoutMs: 3000,
      socketTimeoutMs: 4000,
    });

    expect(createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionTimeout: 2000,
        greetingTimeout: 3000,
        socketTimeout: 4000,
      }),
    );
  });
});
