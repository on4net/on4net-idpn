import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { IDPN_MFE_CONTRACT_VERSION, IDPN_MFE_SDK_VERSION } from './version.js';

describe('SDK version metadata', () => {
  it('follows Semantic Versioning', () => {
    expect(IDPN_MFE_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('matches the published package version', () => {
    const packageJson = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version?: unknown };

    expect(packageJson.version).toBe(IDPN_MFE_SDK_VERSION);
  });

  it('exposes a positive integer contract version', () => {
    expect(Number.isInteger(IDPN_MFE_CONTRACT_VERSION)).toBe(true);
    expect(IDPN_MFE_CONTRACT_VERSION).toBeGreaterThan(0);
  });
});
