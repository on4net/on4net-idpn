import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import type { IssueLogoutTokenInput } from './logout-token.js';

/** Durable fallback queue drained by the retry worker (docs/roadmap.md phase 3). */
export const BACKCHANNEL_LOGOUT_QUEUE_KEY = 'idpn:logout-queue';
/** Entries that exhausted their attempts; kept for operators, never redelivered. */
export const BACKCHANNEL_LOGOUT_DEAD_LETTER_KEY = 'idpn:logout-queue:dead';
/** One in-flight list so a crashed worker cannot lose an entry (BLMOVE target). */
export const BACKCHANNEL_LOGOUT_INFLIGHT_KEY = 'idpn:logout-queue:inflight';
/** Hard cap so a permanently failing client cannot grow the list without bound. */
export const BACKCHANNEL_LOGOUT_QUEUE_MAX = 1000;

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

/**
 * A queued delivery stores the identifiers, never the token: a Logout Token lives 120 s, so
 * the drain worker issues a fresh one per attempt (docs/auth-flows.md 6.3). Keeping the
 * token out of Redis also keeps signed token material and `sub` out of the list payload.
 */
export interface QueuedBackchannelLogout {
  clientId: string;
  sid: string;
  sub?: string;
  uri: string;
  attempts: number;
  queuedAt: string;
  /** Earliest time the drain worker may retry; absent means "now". */
  nextAttemptAt?: string;
}

export interface BackchannelLogoutQueue {
  push(entry: QueuedBackchannelLogout): Promise<void>;
}

/** Subset of the Redis client used for the durable queue. */
export interface RedisListClient {
  lpush(key: string, value: string): Promise<number>;
  ltrim?(key: string, start: number, stop: number): Promise<unknown>;
}

export class RedisBackchannelLogoutQueue implements BackchannelLogoutQueue {
  constructor(private readonly redis: RedisListClient) {}

  async push(entry: QueuedBackchannelLogout): Promise<void> {
    await this.redis.lpush(BACKCHANNEL_LOGOUT_QUEUE_KEY, JSON.stringify(entry));
    // Bounded list: the oldest entries fall off instead of growing forever.
    await this.redis.ltrim?.(BACKCHANNEL_LOGOUT_QUEUE_KEY, 0, BACKCHANNEL_LOGOUT_QUEUE_MAX - 1);
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
  /** Observability hook for each delivery outcome; receives no token material. */
  onDelivery?: (delivery: BackchannelDelivery) => void;
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
    const delivery = await this.deliverInternal(participant, input);
    this.options.onDelivery?.(delivery);
    return delivery;
  }

  private async deliverInternal(
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
        ...(input.sub === undefined ? {} : { sub: input.sub }),
        uri,
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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * `new URL('https://[::1]/x').hostname` keeps the brackets, so `net.isIP` reports 0 and the
 * private-address rules silently skip every IPv6 literal. Classification always runs on the
 * bare address.
 */
export function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(stripBrackets(hostname).toLowerCase());
}

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
      const mapped = value.slice('::ffff:'.length);
      // `net.isIP` prints IPv4-mapped addresses in dotted form, but a client may send the
      // compressed hex form (`::ffff:7f00:1`) which `isIP` treats as opaque IPv6. Left as-is,
      // that was a direct bypass of every IPv4 rule.
      const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
      if (hex !== null) {
        const high = Number.parseInt(hex[1] ?? '0', 16);
        const low = Number.parseInt(hex[2] ?? '0', 16);
        return isPrivateAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
      }
      return isPrivateAddress(mapped);
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
    if (isPrivateAddress(stripBrackets(url.hostname))) {
      throw new Error('back-channel logout URI must not target a private address');
    }
    return url;
  }
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) {
    return url;
  }
  throw new Error('back-channel logout URI must use https');
}

export type HostResolver = (hostname: string) => Promise<string[]>;

const defaultHostResolver: HostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
};

/**
 * Transport that posts the form body over a connection pinned to a validated address.
 * `address`/`family` come from the SSRF check, so the transport must not resolve the
 * hostname again (that is exactly the rebinding window this contract closes).
 */
export type BackchannelHttpTransport = (
  url: URL,
  body: string,
  options: { timeoutMs: number; address: string; family: 4 | 6 },
) => Promise<{ status: number }>;

const defaultTransport: BackchannelHttpTransport = (url, body, options) =>
  new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const hostname = stripBrackets(url.hostname);
    const request_ = request(
      {
        method: 'POST',
        protocol: url.protocol,
        hostname,
        ...(url.port === '' ? {} : { port: Number(url.port) }),
        path: `${url.pathname}${url.search}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cache-Control': 'no-store',
          'Content-Length': String(Buffer.byteLength(body)),
        },
        timeout: options.timeoutMs,
        // The only resolution the request performs: the address that was validated a moment
        // ago. A DNS answer that changes in between cannot steer the token anywhere else.
        // Node calls this with `{ all: true }` when `autoSelectFamily` is on and then expects
        // an *array*; returning the single-address shape throws ERR_INVALID_IP_ADDRESS and
        // every real delivery failed before connecting (card #73 finding 1).
        lookup: (_host, lookupOptions, callback) => {
          const wantsAll =
            typeof lookupOptions === 'object' &&
            lookupOptions !== null &&
            (lookupOptions as { all?: boolean }).all === true;
          if (wantsAll) {
            (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(
              null,
              [{ address: options.address, family: options.family }],
            );
            return;
          }
          callback(null, options.address, options.family);
        },
        ...(url.protocol === 'https:' ? { servername: hostname } : {}),
      },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      },
    );
    request_.on('timeout', () => request_.destroy(new Error('back-channel logout timed out')));
    request_.on('error', reject);
    request_.end(body);
  });

export interface FetchBackchannelLogoutSenderOptions {
  /** Network transport; tests inject a fake, production uses the pinned default. */
  transport?: BackchannelHttpTransport;
  timeoutMs?: number;
  resolveHost?: HostResolver;
}

/**
 * Posts `logout_token` as `application/x-www-form-urlencoded` (docs/auth-flows.md 6.3).
 *
 * The destination is a registered client URL, but it is re-checked at send time (scheme,
 * credentials, wildcards and private address resolution) because registration data can
 * change and DNS can point at internal infrastructure. The connection is then pinned to the
 * address that passed the check, so a resolver that changes its answer between the check and
 * the request (DNS rebinding, T17) cannot reach an internal host.
 */
export class FetchBackchannelLogoutSender implements BackchannelLogoutSender {
  private readonly transport: BackchannelHttpTransport;
  private readonly timeoutMs: number;
  private readonly resolveHost: HostResolver;

  constructor(options: FetchBackchannelLogoutSenderOptions = {}) {
    this.transport = options.transport ?? defaultTransport;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.resolveHost = options.resolveHost ?? defaultHostResolver;
  }

  async send(uri: string, logoutToken: string): Promise<void> {
    const url = assertBackchannelLogoutUri(uri);
    const pinned = await this.pinnedTarget(url);
    const body = new URLSearchParams({ logout_token: logoutToken }).toString();
    const { status } = await this.transport(url, body, {
      timeoutMs: this.timeoutMs,
      ...pinned,
    });
    if (status < 200 || status >= 300) {
      throw new Error(`back-channel logout failed with status ${status}`);
    }
  }

  /** Resolves the destination once, rejects private answers and returns the pinned address. */
  private async pinnedTarget(url: URL): Promise<{ address: string; family: 4 | 6 }> {
    const host = stripBrackets(url.hostname);
    const literal = isIP(host);
    if (literal === 4 || literal === 6) {
      // `assertBackchannelLogoutUri` already rejected private literals (including `[::1]`).
      return { address: host, family: literal };
    }

    const addresses = await this.resolveHost(host);
    if (addresses.length === 0) {
      throw new Error('back-channel logout host did not resolve');
    }
    const loopback = url.protocol === 'http:' && isLoopbackHostname(host);
    if (!loopback && addresses.some((address) => isPrivateAddress(address))) {
      throw new Error('back-channel logout host resolves to a private address');
    }
    const chosen = addresses[0] ?? '';
    const family = isIP(chosen);
    if (family !== 4 && family !== 6) {
      throw new Error('back-channel logout host resolved to a non-IP address');
    }
    return { address: chosen, family };
  }
}

/** Subset of the Redis client the drain worker needs (BLMOVE keeps the entry safe). */
export interface RedisQueueDrainClient extends RedisListClient {
  blmove(
    source: string,
    destination: string,
    from: 'LEFT' | 'RIGHT',
    to: 'LEFT' | 'RIGHT',
    timeoutSeconds: number,
  ): Promise<string | null>;
  lrem(key: string, count: number, value: string): Promise<number>;
  /** Optional: lets the drainer reclaim entries stranded by a crashed worker. */
  lrange?(key: string, start: number, stop: number): Promise<string[]>;
}

export interface BackchannelLogoutQueueDrainerOptions {
  redis: RedisQueueDrainClient;
  tokens: LogoutTokenSource;
  sender: BackchannelLogoutSender;
  /** Attempts recorded on the entry plus the worker's own; 5 by default. */
  maxAttempts?: number;
  /** Entries moved per `drainOnce` call. */
  batchSize?: number;
  /** Seconds BLMOVE waits for an entry; 1 by default. */
  blockSeconds?: number;
  /**
   * In-flight entries older than this are assumed to belong to a crashed worker and are put
   * back on the queue. Work on one entry takes seconds, so the default is generous.
   */
  staleAfterMs?: number;
  /** Backoff for the next worker attempt. */
  retryDelayMs?: readonly number[];
  now?: () => Date;
  onError?: (
    error: unknown,
    context: { clientId: string; phase: 'issue' | 'send' | 'queue' },
  ) => void;
  onDelivery?: (delivery: BackchannelDelivery) => void;
}

/**
 * Drains the durable queue (finding: the queue had no consumer, so a failed delivery was
 * never retried and the list grew without bound while holding signed tokens and `sub`).
 *
 * - `BLMOVE` moves an entry to an in-flight list, so a worker crash cannot lose it.
 * - A fresh Logout Token is issued per attempt: queued tokens live 120 s and would be dead
 *   by the time the worker runs, which is why the payload carries identifiers only.
 * - After `maxAttempts` the entry moves to the dead-letter list instead of cycling forever.
 */
export class BackchannelLogoutQueueDrainer {
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private readonly blockSeconds: number;
  private readonly retryDelayMs: readonly number[];
  private readonly now: () => Date;

  constructor(private readonly options: BackchannelLogoutQueueDrainerOptions) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.batchSize = options.batchSize ?? 10;
    this.blockSeconds = options.blockSeconds ?? 1;
    this.retryDelayMs = options.retryDelayMs ?? [60, 300, 900, 3600];
    this.now = options.now ?? (() => new Date());
  }

  /** Moves up to `batchSize` entries; returns how many were attempted. */
  async drainOnce(): Promise<number> {
    await this.reclaimStranded();
    let processed = 0;
    const deferred = new Set<string>();
    for (let index = 0; index < this.batchSize; index += 1) {
      const raw = await this.options.redis.blmove(
        BACKCHANNEL_LOGOUT_QUEUE_KEY,
        BACKCHANNEL_LOGOUT_INFLIGHT_KEY,
        'RIGHT',
        'LEFT',
        this.blockSeconds,
      );
      if (raw === null) {
        break;
      }
      if (deferred.has(raw)) {
        // Every entry in the queue is waiting for its retry time; stop instead of moving the
        // same entries back and forth for the rest of the batch (card #73 finding 5).
        await this.requeue(raw);
        break;
      }
      processed += 1;
      if (await this.attempt(raw)) {
        deferred.add(raw);
      }
    }
    return processed;
  }

  /**
   * Puts entries left in the in-flight list by a crashed worker back on the queue. Without
   * this nothing ever reads `BACKCHANNEL_LOGOUT_INFLIGHT_KEY`, so an entry stranded between
   * `BLMOVE` and `lrem` was never retried (card #73 finding 5).
   */
  private async reclaimStranded(): Promise<void> {
    const lrange = this.options.redis.lrange;
    if (lrange === undefined) {
      return;
    }
    const staleBefore = this.now().getTime() - (this.options.staleAfterMs ?? 5 * 60 * 1000);
    let entries: string[];
    try {
      entries = await lrange.call(this.options.redis, BACKCHANNEL_LOGOUT_INFLIGHT_KEY, 0, -1);
    } catch {
      return;
    }
    for (const raw of entries) {
      let queuedAt: number;
      try {
        queuedAt = Date.parse(parseQueuedEntry(raw).queuedAt);
      } catch {
        queuedAt = Number.NaN;
      }
      // Unparseable entries are parked by `attempt`; only reclaim the ones we can date.
      if (!Number.isFinite(queuedAt) || queuedAt > staleBefore) {
        continue;
      }
      await this.requeue(raw);
    }
  }

  private async requeue(raw: string): Promise<void> {
    await this.options.redis.lrem(BACKCHANNEL_LOGOUT_INFLIGHT_KEY, 1, raw);
    // Producers `lpush`, the drainer consumes from the right, so this puts the entry at the
    // back of the queue — exactly where a retry belongs.
    await this.options.redis.lpush(BACKCHANNEL_LOGOUT_QUEUE_KEY, raw);
  }

  /** Returns `true` when the entry was deferred (not due), so the caller can stop the pass. */
  private async attempt(raw: string): Promise<boolean> {
    let entry: QueuedBackchannelLogout;
    try {
      entry = parseQueuedEntry(raw);
    } catch (error) {
      // Not a valid entry: park it instead of retrying it forever.
      await this.options.redis.lrem(BACKCHANNEL_LOGOUT_INFLIGHT_KEY, 1, raw);
      await this.options.redis.lpush(
        BACKCHANNEL_LOGOUT_DEAD_LETTER_KEY,
        JSON.stringify({ raw, reason: 'malformed', deadAt: this.now().toISOString() }),
      );
      this.options.onError?.(error, { clientId: '', phase: 'queue' });
      return false;
    }

    const dueAt = entry.nextAttemptAt === undefined ? 0 : Date.parse(entry.nextAttemptAt);
    if (Number.isFinite(dueAt) && dueAt > this.now().getTime()) {
      // Not due yet: take it off the in-flight list without spending an attempt.
      await this.requeue(raw);
      return true;
    }

    const attempts = entry.attempts + 1;
    let outcome: 'delivered' | 'failed' = 'failed';
    try {
      const token = await this.options.tokens.issue({
        clientId: entry.clientId,
        sid: entry.sid,
        ...(entry.sub === undefined ? {} : { sub: entry.sub }),
      });
      await this.options.sender.send(entry.uri, token);
      outcome = 'delivered';
    } catch (error) {
      this.options.onError?.(error, {
        clientId: entry.clientId,
        phase: error instanceof Error && error.message.includes('issue') ? 'issue' : 'send',
      });
    }

    await this.options.redis.lrem(BACKCHANNEL_LOGOUT_INFLIGHT_KEY, 1, raw);
    if (outcome === 'delivered') {
      this.options.onDelivery?.({ clientId: entry.clientId, status: 'delivered', attempts });
      return false;
    }

    if (attempts >= this.maxAttempts) {
      await this.options.redis.lpush(
        BACKCHANNEL_LOGOUT_DEAD_LETTER_KEY,
        JSON.stringify({ ...entry, attempts, deadAt: this.now().toISOString() }),
      );
      this.options.onDelivery?.({ clientId: entry.clientId, status: 'failed', attempts });
      return false;
    }

    const delay = this.retryDelayMs[attempts - 1] ?? this.retryDelayMs.at(-1) ?? 60;
    await this.options.redis.lpush(
      BACKCHANNEL_LOGOUT_QUEUE_KEY,
      JSON.stringify({
        ...entry,
        attempts,
        nextAttemptAt: new Date(this.now().getTime() + delay * 1000).toISOString(),
      }),
    );
    this.options.onDelivery?.({ clientId: entry.clientId, status: 'queued', attempts });
    return false;
  }
}

function parseQueuedEntry(raw: string): QueuedBackchannelLogout {
  const parsed = JSON.parse(raw) as Partial<QueuedBackchannelLogout>;
  if (
    typeof parsed.clientId !== 'string' ||
    parsed.clientId === '' ||
    typeof parsed.sid !== 'string' ||
    parsed.sid === '' ||
    typeof parsed.uri !== 'string' ||
    parsed.uri === '' ||
    typeof parsed.attempts !== 'number' ||
    typeof parsed.queuedAt !== 'string'
  ) {
    throw new Error('queued back-channel logout entry is malformed');
  }
  return {
    clientId: parsed.clientId,
    sid: parsed.sid,
    uri: parsed.uri,
    attempts: parsed.attempts,
    queuedAt: parsed.queuedAt,
    ...(typeof parsed.sub === 'string' ? { sub: parsed.sub } : {}),
    ...(typeof parsed.nextAttemptAt === 'string' ? { nextAttemptAt: parsed.nextAttemptAt } : {}),
  };
}
