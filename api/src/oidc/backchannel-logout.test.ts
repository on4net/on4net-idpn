import { describe, expect, it, vi } from 'vitest';

import {
  BACKCHANNEL_LOGOUT_DEAD_LETTER_KEY,
  BACKCHANNEL_LOGOUT_INFLIGHT_KEY,
  BACKCHANNEL_LOGOUT_QUEUE_KEY,
  BackchannelLogoutDispatcher,
  BackchannelLogoutQueueDrainer,
  FetchBackchannelLogoutSender,
  assertBackchannelLogoutUri,
  isPrivateAddress,
  type BackchannelHttpTransport,
  type BackchannelLogoutQueue,
  type BackchannelLogoutSender,
  type HostResolver,
  type QueuedBackchannelLogout,
  type RedisQueueDrainClient,
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
  interface Sent {
    url: URL;
    body: string;
    options: { timeoutMs: number; address: string; family: 4 | 6 };
  }

  const recordingTransport = (
    status = 200,
  ): BackchannelHttpTransport & { calls: Sent[] } => {
    const calls: Sent[] = [];
    const transport = (async (url: URL, body: string, options: Sent['options']) => {
      calls.push({ url, body, options });
      return { status };
    }) as BackchannelHttpTransport & { calls: Sent[] };
    transport.calls = calls;
    return transport;
  };

  const publicHost: HostResolver = async () => ['203.0.113.10'];

  it('posts the logout token as an urlencoded form over the validated address', async () => {
    const transport = recordingTransport();
    const sender = new FetchBackchannelLogoutSender({ transport, resolveHost: publicHost });

    await sender.send('https://app.example.com/auth/backchannel-logout', 'signed-token');

    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0]!;
    expect(call.url.toString()).toBe('https://app.example.com/auth/backchannel-logout');
    expect(call.body).toBe('logout_token=signed-token');
    expect(call.options.timeoutMs).toBe(5000);
    // Pinned: the transport must not resolve the host again (DNS rebinding).
    expect(call.options).toMatchObject({ address: '203.0.113.10', family: 4 });
  });

  it('fails on a non-2xx response so the dispatcher can retry', async () => {
    const sender = new FetchBackchannelLogoutSender({
      transport: recordingTransport(503),
      resolveHost: publicHost,
    });

    await expect(sender.send('https://app.example.com/bc', 'token')).rejects.toThrow(/503/);
  });

  it('rejects unsafe destinations before any network call', async () => {
    const transport = recordingTransport();
    const sender = new FetchBackchannelLogoutSender({ transport, resolveHost: publicHost });

    await expect(sender.send('http://app.example.com/bc', 'token')).rejects.toThrow(/https/);
    await expect(sender.send('https://10.0.0.5/bc', 'token')).rejects.toThrow(/private/);
    await expect(sender.send('https://app.example.com/*', 'token')).rejects.toThrow(/wildcard/);
    const credentialed = new URL('https://app.example.com/bc');
    credentialed.username = 'user';
    credentialed.password = 'pass';
    await expect(sender.send(credentialed.toString(), 'token')).rejects.toThrow(/credentials/);
    expect(transport.calls).toHaveLength(0);
  });

  it('rejects an IPv6 literal private destination such as https://[::1]', async () => {
    const transport = recordingTransport();
    const sender = new FetchBackchannelLogoutSender({ transport, resolveHost: publicHost });

    await expect(sender.send('https://[::1]:8443/after', 'token')).rejects.toThrow(/private/);
    await expect(sender.send('https://[fd00::1]/after', 'token')).rejects.toThrow(/private/);
    expect(transport.calls).toHaveLength(0);
    expect(() => assertBackchannelLogoutUri('https://[::1]:8443/after')).toThrow(/private/);
  });

  it('rejects a hostname that resolves to a private address (SSRF)', async () => {
    const transport = recordingTransport();
    const sender = new FetchBackchannelLogoutSender({
      transport,
      resolveHost: async () => ['10.1.2.3'],
    });

    await expect(sender.send('https://internal.example.com/bc', 'token')).rejects.toThrow(
      /private/,
    );
    expect(transport.calls).toHaveLength(0);
  });

  it('rejects a resolver that answers with a private address after a public first answer', async () => {
    const transport = recordingTransport();
    let answers = 0;
    const sender = new FetchBackchannelLogoutSender({
      transport,
      resolveHost: async () => {
        answers += 1;
        // Rebinding resolver: public on the first look, private afterwards.
        return answers === 1 ? ['203.0.113.10'] : ['127.0.0.1'];
      },
    });

    await sender.send('https://app.example.com/bc', 'token');
    // The transport received the pinned address and never resolved again.
    expect(transport.calls[0]?.options.address).toBe('203.0.113.10');
    expect(answers).toBe(1);
  });

  it('allows a hostname that resolves to a public address', async () => {
    const sender = new FetchBackchannelLogoutSender({
      transport: recordingTransport(204),
      resolveHost: publicHost,
    });

    await expect(sender.send('https://app.example.com/bc', 'token')).resolves.toBeUndefined();
  });

  it('allows the documented http loopback target and pins it', async () => {
    const transport = recordingTransport(204);
    const sender = new FetchBackchannelLogoutSender({
      transport,
      resolveHost: async () => ['127.0.0.1'],
    });

    await expect(sender.send('http://localhost:4000/bc', 'token')).resolves.toBeUndefined();
    expect(transport.calls[0]?.options).toMatchObject({ address: '127.0.0.1', family: 4 });
  });

  it('fails when the host does not resolve', async () => {
    const sender = new FetchBackchannelLogoutSender({
      transport: recordingTransport(),
      resolveHost: async () => [],
    });

    await expect(sender.send('https://app.example.com/bc', 'token')).rejects.toThrow(
      /did not resolve/,
    );
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

  it('queues the identifiers of the failed delivery, never the token', async () => {
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

    const results = await dispatcher.notify({
      sid,
      sub: 'user-1',
      participants: [participants[0]!],
    });

    expect(results).toEqual([{ clientId: 'app-a', status: 'queued', attempts: 3 }]);
    expect(queue.entries).toHaveLength(1);
    const entry = queue.entries[0]!;
    expect(entry).toMatchObject({
      clientId: 'app-a',
      sid,
      sub: 'user-1',
      uri: 'https://app-a.example.com/bc',
      attempts: 3,
      queuedAt: '2026-10-18T12:00:00.000Z',
    });
    // A queued token would be expired (120 s lifetime) and is signed material: the worker
    // re-issues it instead.
    expect(entry).not.toHaveProperty('logoutToken');
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

/** Minimal Redis list double with BLMOVE/LREM semantics for the drain worker. */
function fakeQueueRedis(): RedisQueueDrainClient & {
  lists: Map<string, string[]>;
  entries(key: string): string[];
} {
  const lists = new Map<string, string[]>();
  const list = (key: string): string[] => {
    const existing = lists.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: string[] = [];
    lists.set(key, created);
    return created;
  };
  return {
    lists,
    entries: (key) => [...list(key)],
    async lpush(key, value) {
      list(key).unshift(value);
      return list(key).length;
    },
    async ltrim(key, start, stop) {
      const values = list(key);
      lists.set(key, values.slice(start, stop === -1 ? undefined : stop + 1));
      return 'OK';
    },
    async blmove(source, destination, from, to) {
      const values = list(source);
      if (values.length === 0) {
        return null;
      }
      // `from` is the side the value is taken from (RIGHT = oldest entry for an LPUSH queue).
      const [value] = from === 'RIGHT' ? values.splice(values.length - 1, 1) : values.splice(0, 1);
      if (value === undefined) {
        return null;
      }
      if (to === 'LEFT') {
        list(destination).unshift(value);
      } else {
        list(destination).push(value);
      }
      return value;
    },
    async lrem(key, _count, value) {
      const values = list(key);
      const index = values.indexOf(value);
      if (index === -1) {
        return 0;
      }
      values.splice(index, 1);
      return 1;
    },
  };
}

describe('BackchannelLogoutQueueDrainer', () => {
  const queued = (overrides: Partial<QueuedBackchannelLogout> = {}): QueuedBackchannelLogout => ({
    clientId: 'app-a',
    sid,
    sub: 'user-1',
    uri: 'https://app-a.example.com/bc',
    attempts: 3,
    queuedAt: '2026-10-18T12:00:00.000Z',
    ...overrides,
  });

  it('drains a queued entry by issuing a fresh token and delivering it', async () => {
    const redis = fakeQueueRedis();
    await redis.lpush(BACKCHANNEL_LOGOUT_QUEUE_KEY, JSON.stringify(queued()));
    const issued: string[] = [];
    const sent: Array<{ uri: string; token: string }> = [];
    const drainer = new BackchannelLogoutQueueDrainer({
      redis,
      tokens: {
        async issue(input) {
          const token = `fresh-${issued.length + 1}-${input.clientId}`;
          issued.push(token);
          return token;
        },
      },
      sender: {
        async send(uri, token) {
          sent.push({ uri, token });
        },
      },
      retryDelayMs: [60],
    });

    expect(await drainer.drainOnce()).toBe(1);
    expect(issued).toEqual(['fresh-1-app-a']);
    expect(sent).toEqual([{ uri: 'https://app-a.example.com/bc', token: 'fresh-1-app-a' }]);
    expect(redis.entries(BACKCHANNEL_LOGOUT_QUEUE_KEY)).toEqual([]);
    expect(redis.entries(BACKCHANNEL_LOGOUT_INFLIGHT_KEY)).toEqual([]);
  });

  it('re-queues a failed attempt with backoff and a bumped attempt count', async () => {
    const redis = fakeQueueRedis();
    await redis.lpush(BACKCHANNEL_LOGOUT_QUEUE_KEY, JSON.stringify(queued()));
    const drainer = new BackchannelLogoutQueueDrainer({
      redis,
      tokens: tokenSource(),
      sender: {
        async send() {
          throw new Error('still down');
        },
      },
      retryDelayMs: [120],
      now: () => new Date('2026-10-18T12:00:00Z'),
    });

    await drainer.drainOnce();
    const [raw] = redis.entries(BACKCHANNEL_LOGOUT_QUEUE_KEY);
    expect(raw).toBeDefined();
    const entry = JSON.parse(raw!) as QueuedBackchannelLogout;
    expect(entry.attempts).toBe(4);
    expect(entry.nextAttemptAt).toBe('2026-10-18T12:02:00.000Z');
    expect(redis.entries(BACKCHANNEL_LOGOUT_INFLIGHT_KEY)).toEqual([]);
  });

  it('moves an entry to the dead-letter list after the last attempt', async () => {
    const redis = fakeQueueRedis();
    await redis.lpush(BACKCHANNEL_LOGOUT_QUEUE_KEY, JSON.stringify(queued({ attempts: 4 })));
    const deliveries: string[] = [];
    const drainer = new BackchannelLogoutQueueDrainer({
      redis,
      tokens: tokenSource(),
      sender: {
        async send() {
          throw new Error('permanently down');
        },
      },
      maxAttempts: 5,
      onDelivery: (delivery) => deliveries.push(delivery.status),
    });

    await drainer.drainOnce();
    expect(redis.entries(BACKCHANNEL_LOGOUT_QUEUE_KEY)).toEqual([]);
    const [dead] = redis.entries(BACKCHANNEL_LOGOUT_DEAD_LETTER_KEY);
    expect(JSON.parse(dead!) as Record<string, unknown>).toMatchObject({
      clientId: 'app-a',
      attempts: 5,
    });
    expect(deliveries).toEqual(['failed']);
  });

  it('does not retry an entry before its next attempt time', async () => {
    const redis = fakeQueueRedis();
    await redis.lpush(
      BACKCHANNEL_LOGOUT_QUEUE_KEY,
      JSON.stringify(queued({ nextAttemptAt: '2026-10-18T13:00:00.000Z' })),
    );
    const send = vi.fn();
    const drainer = new BackchannelLogoutQueueDrainer({
      redis,
      tokens: tokenSource(),
      sender: { send },
      now: () => new Date('2026-10-18T12:00:00Z'),
    });

    await drainer.drainOnce();
    expect(send).not.toHaveBeenCalled();
    expect(redis.entries(BACKCHANNEL_LOGOUT_QUEUE_KEY)).toHaveLength(1);
  });

  it('parks a malformed entry instead of retrying it forever', async () => {
    const redis = fakeQueueRedis();
    await redis.lpush(BACKCHANNEL_LOGOUT_QUEUE_KEY, 'not-json');
    const drainer = new BackchannelLogoutQueueDrainer({
      redis,
      tokens: tokenSource(),
      sender: { send: async () => undefined },
    });

    await drainer.drainOnce();
    expect(redis.entries(BACKCHANNEL_LOGOUT_QUEUE_KEY)).toEqual([]);
    expect(redis.entries(BACKCHANNEL_LOGOUT_DEAD_LETTER_KEY)).toHaveLength(1);
  });

  it('stops when the queue is empty', async () => {
    const redis = fakeQueueRedis();
    const drainer = new BackchannelLogoutQueueDrainer({
      redis,
      tokens: tokenSource(),
      sender: { send: async () => undefined },
    });

    expect(await drainer.drainOnce()).toBe(0);
  });
});
