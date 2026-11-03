import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { duplicateKeys, validateBundles } from '../scripts/check-messages.mjs';

const script = fileURLToPath(new URL('../scripts/check-messages.mjs', import.meta.url));

describe('message bundle checker', () => {
  it('passes on the shipped bundles', () => {
    const output = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    expect(output).toContain('Message bundles OK');
  });

  it('detects duplicate keys in the raw JSON', () => {
    expect(duplicateKeys('{"a.b": "x", "a.b": "y"}')).toEqual(['a.b']);
    expect(duplicateKeys('{"a.b": "x", "a.c": "y"}')).toEqual([]);
  });

  it('detects missing keys in either direction', () => {
    const reference = JSON.stringify({ 'login.title': 'x' });
    expect(validateBundles({ 'fa-IR': reference, 'en-US': '{}' })).toContain(
      'en-US: missing key login.title',
    );
    expect(
      validateBundles({
        'fa-IR': reference,
        'en-US': JSON.stringify({ 'login.title': 'x', 'login.extra': 'y' }),
      }),
    ).toContain('fa-IR: missing key login.extra (present in en-US)');
  });

  it('rejects empty values, markup and unknown namespaces', () => {
    const errors = validateBundles({
      'fa-IR': JSON.stringify({
        'login.title': ' ',
        'login.html': '<b>x</b>',
        'unknown.key': 'x',
      }),
      'en-US': JSON.stringify({
        'login.title': ' ',
        'login.html': '<b>x</b>',
        'unknown.key': 'x',
      }),
    });
    expect(errors.join('\n')).toContain('login.title must be a non-empty string');
    expect(errors.join('\n')).toContain('login.html must be plain text');
    expect(errors.join('\n')).toContain('unknown.key is outside the allowed namespaces');
  });
});
