import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Source-level localization guard (docs/localization.md 4, 8 and 12,
 * docs/design-system.md 6 "متن‌ها").
 *
 * The shared UI must not invent user-facing text: every visible string comes from the base
 * bundle (or a validated per-client override), so a hardcoded literal would silently stay
 * Persian inside an English screen. The rule is checked on the TypeScript AST rather than
 * with a text search, so class names, test ids and comments cannot cause false positives.
 */

const CWD = process.cwd();
const WEB_ROOT = basename(CWD) === 'web' ? CWD : join(CWD, 'web');
const SCAN_DIRECTORIES = ['src/app', 'src/mfe'];

/** Attributes whose value is read by users or assistive technology. */
const USER_FACING_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-valuetext',
  'placeholder',
  'title',
  'alt',
]);

const HAS_LETTERS = /[A-Za-z\u0600-\u06FF]/;
/** `toLocaleString()` without a locale silently follows the host machine. */
const LOCALE_LESS_TO_LOCALE = /\.(?:toLocaleString|toLocaleDateString|toLocaleTimeString)\(\s*\)/g;

interface Finding {
  file: string;
  line: number;
  column: number;
  message: string;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    if (!entry.name.endsWith('.tsx') || /\.test\.tsx?$/.test(entry.name)) {
      return [];
    }
    return [path];
  });
}

function normalize(file: string): string {
  return relative(WEB_ROOT, file).split(sep).join('/');
}

function scan(file: string): Finding[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];

  const report = (node: ts.Node, message: string): void => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({
      file: normalize(file),
      line: position.line + 1,
      column: position.character + 1,
      message,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const value = node.text.replace(/\s+/g, ' ').trim();
      if (HAS_LETTERS.test(value)) {
        report(node, `hardcoded JSX text: "${value}"`);
      }
    }
    if (
      ts.isJsxExpression(node) &&
      node.expression !== undefined &&
      (ts.isStringLiteral(node.expression) ||
        ts.isNoSubstitutionTemplateLiteral(node.expression)) &&
      HAS_LETTERS.test(node.expression.text)
    ) {
      report(node, `hardcoded JSX expression: "${node.expression.text}"`);
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      if (name === 'dangerouslySetInnerHTML') {
        report(node, 'dangerouslySetInnerHTML is forbidden for translated text');
      }
      if (
        USER_FACING_ATTRIBUTES.has(name) &&
        node.initializer !== undefined &&
        ts.isStringLiteral(node.initializer) &&
        HAS_LETTERS.test(node.initializer.text)
      ) {
        report(node, `hardcoded ${name}: "${node.initializer.text}"`);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);

  for (const match of text.matchAll(LOCALE_LESS_TO_LOCALE)) {
    const position = source.getLineAndCharacterOfPosition(match.index ?? 0);
    findings.push({
      file: normalize(file),
      line: position.line + 1,
      column: position.character + 1,
      message: 'locale-less toLocale*String() call',
    });
  }

  return findings;
}

const files = SCAN_DIRECTORIES.flatMap((directory) => sourceFiles(join(WEB_ROOT, directory)));
const findings = files.flatMap(scan);

const format = (entries: readonly Finding[]): string =>
  entries
    .map((entry) => `${entry.file}:${entry.line}:${entry.column} — ${entry.message}`)
    .join('\n');

describe('localization source scan', () => {
  it('covers the Hosted UI and both federated modules', () => {
    const names = files.map(normalize);

    expect(names).toContain('src/app/hosted-login.tsx');
    expect(names).toContain('src/app/mfa-form.tsx');
    expect(names).toContain('src/app/login-context-selector.tsx');
    expect(names).toContain('src/mfe/account.tsx');
    expect(names).toContain('src/mfe/user-management.tsx');
    expect(names.length).toBeGreaterThan(10);
  });

  it('has no hardcoded user-facing text or attribute literals', () => {
    const hardcoded = findings.filter(
      (entry) => !entry.message.startsWith('locale-less') && !entry.message.includes('forbidden'),
    );

    expect(format(hardcoded)).toBe('');
  });

  it('never injects message HTML and always passes a locale to toLocale*String', () => {
    const unsafe = findings.filter(
      (entry) => entry.message.includes('forbidden') || entry.message.startsWith('locale-less'),
    );

    expect(format(unsafe)).toBe('');
  });
});
