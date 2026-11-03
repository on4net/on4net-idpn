import { describe, expect, it, vi } from 'vitest';

import { installTrustedTypesPolicy, TRUSTED_TYPES_POLICY_NAME } from './trusted-types';

describe('installTrustedTypesPolicy', () => {
  it('registers the single allowed policy and refuses every sink', () => {
    const createPolicy = vi.fn();
    expect(installTrustedTypesPolicy({ trustedTypes: { createPolicy } })).toBe(true);

    expect(createPolicy).toHaveBeenCalledTimes(1);
    const [name, rules] = createPolicy.mock.calls[0] as [
      string,
      Record<string, (input: string) => string>,
    ];
    expect(name).toBe(TRUSTED_TYPES_POLICY_NAME);
    expect(() => rules.createHTML?.('<img onerror=x>')).toThrow(/not permitted/);
    expect(() => rules.createScript?.('alert(1)')).toThrow(/not permitted/);
    expect(() => rules.createScriptURL?.('https://evil.example/x.js')).toThrow(/not permitted/);
  });

  it('is a no-op without browser support and tolerates a duplicate policy', () => {
    expect(installTrustedTypesPolicy({})).toBe(false);
    const duplicate = {
      createPolicy: () => {
        throw new TypeError('Policy with name "idpn" already exists');
      },
    };
    expect(installTrustedTypesPolicy({ trustedTypes: duplicate })).toBe(false);
  });
});
