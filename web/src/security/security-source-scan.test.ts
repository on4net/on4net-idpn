import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Source-level MFE security guard (docs/security.md 7, docs/micro-frontend.md 12).
 *
 * The rule set is intentionally narrow and high-signal: every finding below is a control the
 * documented threat model forbids in the Hosted UI, the federated modules, the SDK or the
 * Vite configuration. Tests are excluded because they assert the absence of these patterns.
 */

const CWD = process.cwd();
const WEB_ROOT = basename(CWD) === 'web' ? CWD : join(CWD, 'web');
const REPO_ROOT = resolve(WEB_ROOT, '..');

interface ScanTarget {
  root: string;
  directories: readonly string[];
  prefix: string;
}

const TARGETS: readonly ScanTarget[] = [
  {
    prefix: 'web',
    root: WEB_ROOT,
    directories: ['src', 'host-mf'],
  },
  {
    prefix: 'packages/mfe-sdk',
    root: REPO_ROOT,
    directories: ['packages/mfe-sdk/src'],
  },
];

const VITE_CONFIGS = [
  'web/vite.config.ts',
  'web/vite.host.config.ts',
  'web/vite.mfe.config.ts',
  'web/vite.webcomponent.config.ts',
];

/** High-signal credential shapes; a false positive here is unlikely and worth investigating. */
const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'Stripe live key', pattern: /\bsk_live_[A-Za-z0-9]{24,}\b/ },
  {
    name: 'hardcoded client secret',
    pattern: /\bclient_?secret\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
  },
];

const WILDCARD_CORS =
  /(?:Access-Control-Allow-Origin['"]?\s*[:=]\s*['"]\*['"])|(?:setHeader\(\s*['"]Access-Control-Allow-Origin['"]\s*,\s*['"]\*['"]\s*\))/;

/** A token in a query string or fragment is readable by scripts, history and Referer. */
const TOKEN_IN_URL = /[?&#](?:access_token|id_token|refresh_token)=/;

interface Finding {
  file: string;
  line: number;
  column: number;
  message: string;
}

const isTestFile = (name: string): boolean => /\.test\.tsx?$/.test(name);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    if (!/\.tsx?$/.test(entry.name) || isTestFile(entry.name)) {
      return [];
    }
    return [path];
  });
}

const normalize = (file: string): string => relative(REPO_ROOT, file).split(sep).join('/');

const isIdentifierCall = (node: ts.CallExpression, name: string): boolean =>
  ts.isIdentifier(node.expression) && node.expression.text === name;

/** Scans one source string; exported so the rules themselves are covered by a test. */
export function scanSource(file: string, text: string): Finding[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const findings: Finding[] = [];

  const report = (node: ts.Node, message: string): void => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ file, line: position.line + 1, column: position.character + 1, message });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'dangerouslySetInnerHTML') {
      report(node, 'dangerouslySetInnerHTML is forbidden');
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      (node.name.text === 'innerHTML' || node.name.text === 'outerHTML')
    ) {
      // Reads are harmless; only assignments (`.innerHTML = …`) inject markup.
      if (
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        report(node, `${node.name.text} assignment is forbidden`);
      }
    }
    if (ts.isCallExpression(node) && isIdentifierCall(node, 'eval')) {
      report(node, 'eval() is forbidden');
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Function'
    ) {
      report(node, 'new Function() is forbidden');
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'write' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'document'
    ) {
      report(node, 'document.write() is forbidden');
    }
    if (
      (ts.isIdentifier(node) || ts.isStringLiteral(node)) &&
      (node.text === 'localStorage' || node.text === 'sessionStorage')
    ) {
      report(node, 'token storage is forbidden; keep tokens in memory');
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'postMessage'
    ) {
      const target = node.arguments[1];
      if (
        target !== undefined &&
        (ts.isStringLiteral(target) || ts.isNoSubstitutionTemplateLiteral(target)) &&
        target.text === '*'
      ) {
        report(node, "postMessage(targetOrigin) must not be '*'");
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);

  for (const rule of SECRET_PATTERNS) {
    for (const match of text.matchAll(new RegExp(rule.pattern.source, `${rule.pattern.flags}g`))) {
      const position = source.getLineAndCharacterOfPosition(match.index ?? 0);
      findings.push({
        file,
        line: position.line + 1,
        column: position.character + 1,
        message: `hardcoded credential: ${rule.name}`,
      });
    }
  }

  if (WILDCARD_CORS.test(text)) {
    findings.push({
      file,
      line: 1,
      column: 1,
      message: "Access-Control-Allow-Origin must not be '*'",
    });
  }

  if (TOKEN_IN_URL.test(text)) {
    findings.push({ file, line: 1, column: 1, message: 'token in URL is forbidden' });
  }

  return findings;
}

const scannedFiles = [
  ...TARGETS.flatMap((target) =>
    target.directories.flatMap((directory) => sourceFiles(join(target.root, directory))),
  ),
  ...VITE_CONFIGS.map((file) => join(REPO_ROOT, file)),
];

const findings = scannedFiles.flatMap((file) =>
  scanSource(normalize(file), readFileSync(file, 'utf8')),
);

const format = (entries: readonly Finding[]): string =>
  entries
    .map((entry) => `${entry.file}:${entry.line}:${entry.column} — ${entry.message}`)
    .join('\n');

describe('MFE security source scan', () => {
  it('covers the Hosted UI, both modules, the SDK and the Vite servers', () => {
    const names = scannedFiles.map(normalize);

    expect(names).toContain('web/src/app/hosted-login.tsx');
    expect(names).toContain('web/src/mfe/web-component.tsx');
    expect(names).toContain('web/src/mfe/user-management.tsx');
    expect(names).toContain('packages/mfe-sdk/src/mount.ts');
    expect(names).toContain('web/vite.mfe.config.ts');
    expect(names.length).toBeGreaterThan(30);
  });

  it('detects every forbidden pattern', () => {
    const synthetic = [
      'element.innerHTML = userInput;',
      'const html = { __html: value };',
      'const node = <div dangerouslySetInnerHTML={html} />;',
      'eval(code);',
      'const fn = new Function("return 1");',
      'document.write("<script></script>");',
      'localStorage.setItem("token", token);',
      "window.postMessage({ type: 'auth' }, '*');",
      "const client_secret = 'super-secret-value';",
      "response.setHeader('Access-Control-Allow-Origin', '*');",
      'const target = `${appUrl}/callback#access_token=${token}`;',
    ].join('\n');

    const messages = scanSource('synthetic.tsx', synthetic).map((entry) => entry.message);

    expect(messages).toContain('dangerouslySetInnerHTML is forbidden');
    expect(messages).toContain('innerHTML assignment is forbidden');
    expect(messages).toContain('eval() is forbidden');
    expect(messages).toContain('new Function() is forbidden');
    expect(messages).toContain('document.write() is forbidden');
    expect(messages).toContain('token storage is forbidden; keep tokens in memory');
    expect(messages).toContain("postMessage(targetOrigin) must not be '*'");
    expect(messages).toContain('hardcoded credential: hardcoded client secret');
    expect(messages).toContain("Access-Control-Allow-Origin must not be '*'");
    expect(messages).toContain('token in URL is forbidden');
  });

  it('allows reads of innerHTML (only injection is forbidden)', () => {
    expect(scanSource('read.ts', 'const size = node.innerHTML.length;')).toEqual([]);
  });

  it('has no forbidden pattern in the scanned sources', () => {
    expect(format(findings)).toBe('');
  });
});
