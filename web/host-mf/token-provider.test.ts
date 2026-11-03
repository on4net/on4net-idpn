import { describe, expect, it, vi } from 'vitest';

import { createInMemoryTokenProvider } from './token-provider';

describe('createInMemoryTokenProvider', () => {
  it('holds the token in memory only', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const provider = createInMemoryTokenProvider();

    expect(provider.getAccessToken()).toBeNull();

    provider.setAccessToken('header.payload.signature');
    expect(provider.getAccessToken()).toBe('header.payload.signature');

    // Nothing is persisted: no storage write, nothing readable after a reload, no cookie
    // and no serializable property (`JSON.stringify` drops closure state).
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    expect(JSON.stringify(provider)).not.toContain('header.payload.signature');

    provider.clear();
    expect(provider.getAccessToken()).toBeNull();
    setItem.mockRestore();
  });

  it('normalizes an empty token to null', () => {
    const provider = createInMemoryTokenProvider('initial');

    provider.setAccessToken('');
    expect(provider.getAccessToken()).toBeNull();

    provider.setAccessToken(null);
    expect(provider.getAccessToken()).toBeNull();
  });
});
