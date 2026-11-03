import { describe, expect, it } from 'vitest';

import { createMemoryRateLimiter } from './rate-limit.js';

describe('memory rate limiter', () => {
  it('allows up to the limit inside one window and rejects afterwards', async () => {
    const at = 1_000;
    const limiter = createMemoryRateLimiter(() => at);
    const policy = { windowSeconds: 60, max: 2 };

    await expect(limiter.consume('key', policy)).resolves.toBe(true);
    await expect(limiter.consume('key', policy)).resolves.toBe(true);
    await expect(limiter.consume('key', policy)).resolves.toBe(false);
  });

  it('resets when the window elapses and keeps keys independent', async () => {
    let at = 1_000;
    const limiter = createMemoryRateLimiter(() => at);
    const policy = { windowSeconds: 60, max: 1 };

    await expect(limiter.consume('a', policy)).resolves.toBe(true);
    await expect(limiter.consume('b', policy)).resolves.toBe(true);
    await expect(limiter.consume('a', policy)).resolves.toBe(false);

    at += 60_001;
    await expect(limiter.consume('a', policy)).resolves.toBe(true);
  });
});
