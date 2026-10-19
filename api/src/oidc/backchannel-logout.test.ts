import { describe, expect, it, vi } from 'vitest';

import {
  BackchannelLogoutDispatcher,
  FetchBackchannelLogoutSender,
  assertBackchannelLogoutUri,
  isPrivateAddress,
  type BackchannelLogoutQueue,
  type BackchannelLogoutSender,
  type FetchLike,
  type QueuedBackchannelLogout,
} from './backchannel-logout.js';
import type { LogoutTokenSource } from './backchannel-logout.js';

const sid = '0b9f1f8a-6a1e-4d5f-9f4c-0f9f3a5b7c11';

function tokenSource(): LogoutTokenSource {
  return {
    async issue(input) {
      return `token-for-${input.clientId}`;
    },
  };
}

function recordingQueue(): BackchannelLogoutQueue & { entries: QueuedBackchannelLogout[] } {
  const entries: QueuedBackchannelLogout[] = [];
  return {
    entries,
    async push(entry) {
      entries.push(entry);
    },
  };
}

describe('FetchBackchannelLogoutSender', () => {
  it('posts the logout token as an urlencoded form', async () => {
    const calls: Array<{ input: Parameters<FetchLike>[0]; init?: RequestInit }> = [];
    const fetchImpl = (async (input: Parameters<FetchLike>[0], init?: RequestInit) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return { ok: true, status: 200 } as Response;
    }) as FetchLike;
    const sender = new FetchBackchannelLogoutSender({
      fetchImpl,
      resolveHost: async () => ['203.0.113.10'],
    });

    await sender.send('https://app.example.com/auth/backchannel-logout', 'signed-token');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('https://app.example.com/auth/backchannel-logout');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-store',
    });
    expect(calls[0]?.init?.body).toBe('logout_token=signed-token');
    expect(calls[0]?.init?.redirect).toBe('error');
    expect(calls[0]?.init?.signal).toBeDefined();
  });

  it('fails on a non-2xx response so the dispatcher can retry', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503 }) as Response) as FetchLike;
    const sender = new FetchBackchannelLogoutSender({
      fetchImpl,
      resolveHost: async () => ['203.0.113.10'],
    });

    await expect(sender.send('https://app.example.com/bc', 'token')).rejects.toThrow(/503/);
  });

  it('rejects unsafe destinations before any network call', async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike;
    const sender = new FetchBackchannelLogoutSender({
      fetchImpl,
      resolveHost: async () => ['203.0.113.10'],
    });

    await expect(sender.send('http://app.example.com/bc', 'token')).rejects.toThrow(/https/);
    await expect(sender.send('https://10.0.0.5/bc', 'token')).rejects.toThrow(/private/);
    await expect(sender.send('https://app.example.com/*', 'token')).rejects.toThrow(/wildcard/);
    const credentialed = new URL('https://app.example.com/bc');
    credentialed.username = 'user';
    credentialed.password = 'pass';
    await expect(sender.send(credentialed.toString(), 'token')).rejects.toThrow(/credentials/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a hostname that resolves to a private address (SSRF)', async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike;
    const sender = new FetchBackchannelLogoutSender({
      fetchImpl,
      resolveHost: async () => ['10.1.2.3'],
    });

    await expect(sender.send('https://internal.example.com/bc', 'token')).rejects.toThrow(
      /private/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows a hostname that resolves to a public address', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 204 }) as Response) as FetchLike;
    const sender = new FetchBackchannelLogoutSender({
      fetchImpl,
      resolveHost: async () => ['203.0.113.10'],
    });

    await expect(sender.send('https://app.example.com/bc', 'token')).resolves.toBeUndefined();
  });
});

describe('assertBackchannelLogoutUri / isPrivateAddress', () => {
  it('allows https and loopback http only', () => {
    expect(() => assertBackchannelLogoutUri('https://app.example.com/bc')).not.toThrow();
    expect(() => assertBackchannelLogoutUri('http://127.0.0.1:4000/bc')).not.toThrow();
    expect(() => assertBackchannelLogoutUri('http://localhost:4000/bc')).not.toThrow();
    expect(() => assertBackchannelLogoutUri('ftp://app.example.com/bc')).toThrow();
  });

  it('classifies reserved address ranges', () => {
    for (const address of ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.16.4.4', '169.254.1.1']) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    for (const address of ['::1', 'fd00::1', 'fe80::1']) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    expect(isPrivateAddress('203.0.113.10')).toBe(false);
    expect(isPrivateAddress('2001:db8::1')).toBe(false);
  });
});

describe('BackchannelLogoutDispatcher', () => {
  const participants = [
    { clientId: 'app-a', backchannelLogoutUri: 'https://app-a.example.com/bc' },
    { clientId: 'app-b', backchannelLogoutUri: 'https://app-b.example.com/bc' },
  ];

  it('delivers to every participant once', async () => {
    const sender: BackchannelLogoutSender = { send: async () => undefined };
    const dispatcher = new BackchannelLogoutDispatcher({
      tokens: tokenSource(),
      sender,
      queue: recordingQueue(),
    });

    const results = await dispatcher.notify({ sid, sub: 'user-1', participants });

    expect(results).toEqual([
      { clientId: 'app-a', status: 'delivered', attempts: 1 },
      { clientId: 'app-b', status: 'delivered', attempts: 1 },
    ]);
  });

  it('retries with backoff and then succeeds', async () => {
    const attemptsByUri = new Map<string, number>();
    const sender: BackchannelLogoutSender = {
      async send(uri) {
        const attempt = (attemptsByUri.get(uri) ?? 0) + 1;
        attemptsByUri.set(uri, attempt);
        if (attempt < 3) {
          throw new Error('temporary');
        }
      },
    };
    const delays: number[] = [];
    const queue = recordingQueue();
    const dispatcher = new BackchannelLogoutDispatcher({
      tokens: tokenSource(),
      sender,
      queue,
      retryDelaysMs: [10, 20],
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    const results = await dispatcher.notify({
      sid,
      participants: [participants[0]!],
    });

    expect(results).toEqual([{ clientId: 'app-a', status: 'delivered', attempts: 3 }]);
    expect(delays).toEqual([10, 20]);
    expect(queue.entries).toEqual([]);
  });

  it('queues the signed token after the final failed attempt', async () => {
    const sender: BackchannelLogoutSender = {
      async send() {
        throw new Error('down');
      },
    };
    const queue = recordingQueue();
    const dispatcher = new BackchannelLogoutDispatcher({
      tokens: tokenSource(),
      sender,
      queue,
      retryDelaysMs: [1, 1],
      sleep: async () => undefined,
      now: () => new Date('2026-10-18T12:00:00Z'),
    });

    const results = await dispatcher.notify({ sid, participants: [participants[0]!] });

    expect(results).toEqual([{ clientId: 'app-a', status: 'queued', attempts: 3 }]);
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0]).toMatchObject({
      clientId: 'app-a',
      sid,
      uri: 'https://app-a.example.com/bc',
      logoutToken: 'token-for-app-a',
      attempts: 3,
      queuedAt: '2026-10-18T12:00:00.000Z',
    });
  });

  it('skips clients without a back-channel endpoint', async () => {
    const sender: BackchannelLogoutSender = { send: async () => undefined };
    const dispatcher = new BackchannelLogoutDispatcher({
      tokens: tokenSource(),
      sender,
      queue: recordingQueue(),
    });

    const results = await dispatcher.notify({
      sid,
      participants: [{ clientId: 'app-c', backchannelLogoutUri: null }],
    });

    expect(results).toEqual([{ clientId: 'app-c', status: 'skipped', attempts: 0 }]);
  });

  it('never rejects when one client fails and another succeeds', async () => {
    const sender: BackchannelLogoutSender = {
      async send(uri) {
        if (uri.includes('app-a')) {
          throw new Error('down');
        }
      },
    };
    const queue = recordingQueue();
    const dispatcher = new BackchannelLogoutDispatcher({
      tokens: tokenSource(),
      sender,
      queue,
      retryDelaysMs: [],
      sleep: async () => undefined,
    });

    const results = await dispatcher.notify({ sid, participants });

    expect(results).toEqual([
      { clientId: 'app-a', status: 'queued', attempts: 1 },
      { clientId: 'app-b', status: 'delivered', attempts: 1 },
    ]);
    expect(queue.entries).toHaveLength(1);
  });

  it('reports a token issue failure without throwing', async () => {
    const phases: string[] = [];
    const dispatcher = new BackchannelLogoutDispatcher({
      tokens: {
        async issue() {
          throw new Error('no jti');
        },
      },
      sender: { send: async () => undefined },
      queue: recordingQueue(),
      onError: (_error, context) => {
        phases.push(context.phase);
      },
    });

    const results = await dispatcher.notify({ sid, participants: [participants[0]!] });

    expect(results).toEqual([{ clientId: 'app-a', status: 'failed', attempts: 0 }]);
    expect(phases).toEqual(['issue']);
  });
});
