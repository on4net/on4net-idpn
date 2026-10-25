import { describe, expect, it } from 'vitest';

import { requestSocialJson, type SocialFetch } from './http.js';

const request = {
  provider: 'google' as const,
  operation: 'token exchange',
  method: 'POST' as const,
  url: 'https://provider.example/token',
  retryable: false,
};

/** A body that keeps producing data and records how much of it was actually pulled. */
function endlessBody(chunkBytes: number): { response: Response; pulled: () => number } {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
  });
  return { response: new Response(stream, { status: 200 }), pulled: () => pulled };
}

describe('requestSocialJson body limit', () => {
  it('stops reading an endless body shortly after the 256 KiB cap', async () => {
    const { response, pulled } = endlessBody(64 * 1024);
    const fetchImpl: SocialFetch = async () => response;

    await expect(requestSocialJson({ fetch: fetchImpl }, request)).rejects.toMatchObject({
      code: 'invalid_response',
      message: expect.stringContaining('oversized'),
    });
    // Bounded: the cap plus at most a couple of in-flight chunks, never the whole stream.
    expect(pulled()).toBeLessThanOrEqual(256 * 1024 + 3 * 64 * 1024);
  });

  it('rejects an oversized declared length without reading the body', async () => {
    const fetchImpl: SocialFetch = async () =>
      new Response('{}', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } });
    await expect(requestSocialJson({ fetch: fetchImpl }, request)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('still parses a normal JSON payload', async () => {
    const fetchImpl: SocialFetch = async () =>
      new Response(JSON.stringify({ id_token: 'abc' }), { status: 200 });
    await expect(requestSocialJson({ fetch: fetchImpl }, request)).resolves.toEqual({
      id_token: 'abc',
    });
  });
});
