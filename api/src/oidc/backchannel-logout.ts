import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { IssueLogoutTokenInput } from './logout-token.js';

/** Durable fallback queue drained by the retry worker (docs/roadmap.md phase 3). */
export const BACKCHANNEL_LOGOUT_QUEUE_KEY = 'idpn:logout-queue';

/** One client that took part in the session and therefore must learn about the logout. */
export interface BackchannelLogoutParticipant {
  clientId: string;
  /** `null` when the client did not register a back-channel endpoint. */
  backchannelLogoutUri: string | null;
}

export interface BackchannelLogoutNotifyInput {
  sid: string;
  sub?: string;
  participants: readonly BackchannelLogoutParticipant[];
}

export type BackchannelDeliveryStatus = 'delivered' | 'queued' | 'skipped' | 'failed';

export interface BackchannelDelivery {
  clientId: string;
  status: BackchannelDeliveryStatus;
  attempts: number;
}

export interface BackchannelLogoutSender {
  send(uri: string, logoutToken: string): Promise<void>;
}

export interface QueuedBackchannelLogout {
  clientId: string;
  sid: string;
  uri: string;
  logoutToken: string;
  attempts: number;
  queuedAt: string;
}

export interface BackchannelLogoutQueue {
  push(entry: QueuedBackchannelLogout): Promise<void>;
}

/** Subset of the Redis client used for the durable queue. */
export interface RedisListClient {
  lpush(key: string, value: string): Promise<number>;
}

export class RedisBackchannelLogoutQueue implements BackchannelLogoutQueue {
  constructor(private readonly redis: RedisListClient) {}

  async push(entry: QueuedBackchannelLogout): Promise<void> {
    await this.redis.lpush(BACKCHANNEL_LOGOUT_QUEUE_KEY, JSON.stringify(entry));
  }
}

export interface LogoutTokenSource {
  issue(input: IssueLogoutTokenInput): Promise<string>;
}

export interface BackchannelLogoutDispatcherOptions {
  tokens: LogoutTokenSource;
  sender: BackchannelLogoutSender;
  queue: BackchannelLogoutQueue;
  /** Backoff between attempts. Length + 1 is the attempt count (3 by default). */
  retryDelaysMs?: readonly number[];
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  /** Observability hook; receives no token material. */
  onError?: (
    error: unknown,
    context: { clientId: string; phase: 'issue' | 'send' | 'queue' },
  ) => void;
}

const DEFAULT_RETRY_DELAYS_MS = [250, 1000] as const;

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/**
 * Delivers a Logout Token to every participant.
 *
 * Delivery is best effort by design: a client failure is retried with exponential backoff
 * and then persisted on the Redis queue, so it can never fail or delay the user's logout.
 * `notify` itself never rejects.
 */
export class BackchannelLogoutDispatcher {
  private readonly retryDelaysMs: readonly number[];
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly options: BackchannelLogoutDispatcherOptions) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => new Date());
  }

  async notify(input: BackchannelLogoutNotifyInput): Promise<BackchannelDelivery[]> {
    return Promise.all(input.participants.map((participant) => this.deliver(participant, input)));
  }

  private async deliver(
    participant: BackchannelLogoutParticipant,
    input: BackchannelLogoutNotifyInput,
  ): Promise<BackchannelDelivery> {
    const uri = participant.backchannelLogoutUri;
    if (uri === null || uri === '') {
      return { clientId: participant.clientId, status: 'skipped', attempts: 0 };
    }

    let token: string;
    try {
      token = await this.options.tokens.issue({
        clientId: participant.clientId,
        sid: input.sid,
        ...(input.sub === undefined ? {} : { sub: input.sub }),
      });
    } catch (error) {
      this.options.onError?.(error, { clientId: participant.clientId, phase: 'issue' });
      return { clientId: participant.clientId, status: 'failed', attempts: 0 };
    }

    const attempts = this.retryDelaysMs.length + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.options.sender.send(uri, token);
        return { clientId: participant.clientId, status: 'delivered', attempts: attempt };
      } catch (error) {
        this.options.onError?.(error, { clientId: participant.clientId, phase: 'send' });
        if (attempt < attempts) {
          const delay = this.retryDelaysMs[attempt - 1] ?? this.retryDelaysMs.at(-1) ?? 0;
          await this.sleep(delay);
        }
      }
    }

    try {
      await this.options.queue.push({
        clientId: participant.clientId,
        sid: input.sid,
        uri,
        logoutToken: token,
        attempts,
        queuedAt: this.now().toISOString(),
      });
      return { clientId: participant.clientId, status: 'queued', attempts };
    } catch (error) {
      this.options.onError?.(error, { clientId: participant.clientId, phase: 'queue' });
      return { clientId: participant.clientId, status: 'failed', attempts };
    }
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Reserved/private address ranges that must never receive a Logout Token (T17 SSRF). */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = -1, b = -1] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (family === 6) {
    const value = address.toLowerCase();
    if (value === '::' || value === '::1') {
      return true;
    }
    if (value.startsWith('fc') || value.startsWith('fd')) {
      return true;
    }
    if (/^fe[89ab]/.test(value)) {
      return true;
    }
    if (value.startsWith('::ffff:')) {
      return isPrivateAddress(value.slice('::ffff:'.length));
    }
    return false;
  }
  return false;
}

export function assertBackchannelLogoutUri(uri: string): URL {
  if (uri.includes('*')) {
    throw new Error('back-channel logout URI must not contain wildcards');
  }
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error('back-channel logout URI must be absolute');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('back-channel logout URI must not contain credentials');
  }
  if (url.hash !== '') {
    throw new Error('back-channel logout URI must not contain a fragment');
  }
  if (url.protocol === 'https:') {
    if (isPrivateAddress(url.hostname)) {
      throw new Error('back-channel logout URI must not target a private address');
    }
    return url;
  }
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) {
    return url;
  }
  throw new Error('back-channel logout URI must use https');
}

export type HostResolver = (hostname: string) => Promise<string[]>;

const defaultHostResolver: HostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
};

export type FetchLike = typeof fetch;

export interface FetchBackchannelLogoutSenderOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  resolveHost?: HostResolver;
}

/**
 * Posts `logout_token` as `application/x-www-form-urlencoded` (docs/auth-flows.md 6.3).
 *
 * The destination is a registered client URL, but it is re-checked at send time (scheme,
 * credentials, wildcards and private address resolution) because registration data can
 * change and DNS can point at internal infrastructure.
 */
export class FetchBackchannelLogoutSender implements BackchannelLogoutSender {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly resolveHost: HostResolver;

  constructor(options: FetchBackchannelLogoutSenderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.resolveHost = options.resolveHost ?? defaultHostResolver;
  }

  async send(uri: string, logoutToken: string): Promise<void> {
    const url = assertBackchannelLogoutUri(uri);
    if (isIP(url.hostname) === 0 && !LOOPBACK_HOSTS.has(url.hostname)) {
      const addresses = await this.resolveHost(url.hostname);
      if (addresses.some((address) => isPrivateAddress(address))) {
        throw new Error('back-channel logout host resolves to a private address');
      }
    }

    const response = await this.fetchImpl(uri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-store',
      },
      body: new URLSearchParams({ logout_token: logoutToken }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`back-channel logout failed with status ${response.status}`);
    }
  }
}
