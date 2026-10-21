import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Vitest runs from the package root (`web/`), and jsdom leaves `import.meta.url` non-file. */
const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const css = read('src/styles/fonts.css');
const faces = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];

describe('self-hosted webfonts', () => {
  it('declares a swap-based, unicode-range-scoped face for each shipped file', () => {
    expect(faces).toHaveLength(3);
    for (const face of faces) {
      expect(face).toContain('font-display: swap');
      expect(face).toContain('unicode-range');
      const file = /url\('\/fonts\/([^']+)'\)/.exec(face)?.[1];
      expect(file).toBeDefined();
      const bytes = readFileSync(join(root, 'public/fonts', file ?? ''));
      // A real woff2 container, not an empty placeholder or an HTML error page.
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('wOF2');
      expect(bytes.byteLength).toBeLessThan(200_000);
    }
  });

  it('is loaded by the hosted entry only, never by the embedded module', () => {
    expect(read('src/main.tsx')).toContain('styles/fonts.css');
    expect(read('src/mfe/web-component.tsx')).not.toContain('fonts.css');
  });
});
