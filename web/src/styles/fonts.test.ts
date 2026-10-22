import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Vitest runs from the package root (`web/`), and jsdom leaves `import.meta.url` non-file. */
const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const css = read('src/styles/fonts.css');
const faces = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];

const embeddedEntries = [
  'src/mfe/account.tsx',
  'src/mfe/user-management.tsx',
  'src/mfe/web-component.tsx',
  'src/admin/mount.tsx',
];

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

  it('ships the OFL text with the font files', () => {
    const licence = read('public/fonts/OFL.txt');
    expect(licence).toContain('SIL OPEN FONT LICENSE');
    expect(licence).toContain('Vazirmatn Project Authors');
    expect(licence).toContain('Inter Project Authors');
    // The notices file is the canonical copy; the folder copy is what hosts redistribute.
    expect(read('../THIRD_PARTY_NOTICES.md')).toContain('SIL Open Font License 1.1');
  });

  it('is loaded by the hosted entry only, never by an embedded bundle', () => {
    expect(read('src/main.tsx')).toContain('styles/fonts.css');
    for (const entry of embeddedEntries) {
      expect(existsSync(join(root, entry)), `${entry} should exist`).toBe(true);
      expect(read(entry), `${entry} must not import fonts.css`).not.toContain('fonts.css');
    }
  });

  it('keeps the public directory out of the embedded builds', () => {
    for (const config of ['vite.mfe.config.ts', 'vite.webcomponent.config.ts']) {
      expect(read(config), `${config} must not publish public/fonts`).toContain('publicDir: false');
    }
  });

  it('has no unrelated file in the fonts directory', () => {
    const files = readdirSync(join(root, 'public/fonts')).sort();
    expect(files).toEqual([
      'OFL.txt',
      'inter-latin.woff2',
      'vazirmatn-arabic.woff2',
      'vazirmatn-latin.woff2',
    ]);
  });
});
