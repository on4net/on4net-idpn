import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parsePublicEnv, parseServerEnv } from './env.js';

const examplePath = fileURLToPath(new URL('../../../.env.example', import.meta.url));

const parseDotenv = (content: string): Record<string, string> => {
  const entries: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }
    entries[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return entries;
};

describe('.env.example', () => {
  const example = parseDotenv(readFileSync(examplePath, 'utf8'));

  it('contains a complete, valid server configuration', () => {
    expect(() => parseServerEnv(example)).not.toThrow();
  });

  it('contains the public configuration required by the browser build', () => {
    expect(parsePublicEnv(example).VITE_APP_URL).toBe(example.VITE_APP_URL);
  });

  it('uses a secret placeholder long enough to satisfy the schema', () => {
    expect(parseServerEnv(example).SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
  });
});
