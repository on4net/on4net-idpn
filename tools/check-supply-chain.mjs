#!/usr/bin/env node
/**
 * Supply-chain guards for the design system:
 *  1. every design-system dependency must be an exact version (no ^, ~, latest, *);
 *  2. React and ReactDOM must be one identical version across the workspace (MFE singleton);
 *  3. the approved license allowlist must cover every **production** dependency
 *     (dev-only tooling is recorded in the SBOM but never shipped).
 *
 * Usage: node tools/check-supply-chain.mjs [--licenses]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Dependencies that must never float. */
const PINNED = [
  '@hookform/resolvers',
  '@module-federation/vite',
  '@tailwindcss/vite',
  '@vitejs/plugin-react',
  'class-variance-authority',
  'clsx',
  'radix-ui',
  'react',
  'react-dom',
  'react-hook-form',
  'tailwind-merge',
  'tailwindcss',
  'vite',
  'zod',
];

/** Licenses accepted for shipped dependencies. */
const ALLOWED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
]);

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const problems = [];

const packageFiles = [
  join(ROOT, 'package.json'),
  ...['api', 'web', 'packages/config', 'packages/contracts'].map((dir) =>
    join(ROOT, dir, 'package.json'),
  ),
];

const manifests = packageFiles.map((file) => ({
  file,
  pkg: JSON.parse(readFileSync(file, 'utf8')),
}));

const reactVersions = new Set();

for (const { file, pkg } of manifests) {
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(pkg[section] ?? {})) {
      if (name === 'react' || name === 'react-dom') {
        reactVersions.add(version);
      }
      if (version === 'latest' || version === '*') {
        problems.push(`${file}: ${name} must not use the floating range "${version}"`);
        continue;
      }
      if (PINNED.includes(name) && !EXACT_VERSION.test(version)) {
        problems.push(`${file}: ${name} must be pinned to an exact version, found "${version}"`);
      }
    }
  }
}

if (reactVersions.size > 1) {
  problems.push(
    `react/react-dom must share one exact version across the workspace, found: ${[
      ...reactVersions,
    ].join(', ')}`,
  );
}

if (process.argv.includes('--licenses')) {
  const productionVersions = productionClosure();
  for (const [license, entries] of Object.entries(readLicenseInventory())) {
    if (isAllowedLicense(license)) {
      continue;
    }
    const shipped = entries.filter((entry) =>
      (entry.versions ?? []).some((version) => productionVersions.has(`${entry.name}@${version}`)),
    );
    if (shipped.length > 0) {
      problems.push(
        `unapproved license "${license}" is shipped by: ${shipped
          .map((entry) => entry.name)
          .join(', ')}`,
      );
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`supply-chain: ${problem}`);
  }
  process.exit(1);
}

console.log(
  `Supply-chain check passed: ${PINNED.length} pinned packages, react ${[...reactVersions].join('/')}`,
);

function isAllowedLicense(license) {
  return license
    .split(/\s+(?:AND|OR)\s+|\//i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .every((part) => ALLOWED_LICENSES.has(part));
}

/** `name@version` keys may carry peer suffixes: react@19.3.1(react@19.3.1). */
function splitKey(key) {
  const withoutPeers = key.split('(')[0];
  const at = withoutPeers.lastIndexOf('@');
  if (at <= 0) {
    return null;
  }
  return { name: withoutPeers.slice(0, at), version: withoutPeers.slice(at + 1) };
}

/** Walks every importer's production dependencies and returns `name@version` entries. */
function productionClosure() {
  const lockfile = parse(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8'));
  const packages = lockfile.packages ?? {};
  const byName = new Map();
  for (const [key, entry] of Object.entries(packages)) {
    const parsed = splitKey(key);
    if (parsed === null) {
      continue;
    }
    byName.set(`${parsed.name}@${parsed.version}`, entry);
  }

  const seen = new Set();
  const queue = [];
  for (const importer of Object.values(lockfile.importers ?? {})) {
    for (const [name, spec] of Object.entries(importer.dependencies ?? {})) {
      if (spec?.version) {
        queue.push(`${name}@${spec.version.split('(')[0]}`);
      }
    }
  }

  while (queue.length > 0) {
    const id = queue.pop();
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const entry = byName.get(id);
    for (const [name, version] of Object.entries(entry?.dependencies ?? {})) {
      queue.push(`${name}@${String(version).split('(')[0]}`);
    }
    for (const [name, version] of Object.entries(entry?.optionalDependencies ?? {})) {
      queue.push(`${name}@${String(version).split('(')[0]}`);
    }
  }

  return seen;
}

function readLicenseInventory() {
  try {
    const execPath = process.env.npm_execpath;
    const options = {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    };
    const output =
      execPath !== undefined && execPath !== ''
        ? execFileSync(process.execPath, [execPath, 'licenses', 'list', '--json'], options)
        : execFileSync(
            process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
            ['licenses', 'list', '--json'],
            { ...options, shell: process.platform === 'win32' },
          );
    return JSON.parse(output);
  } catch (error) {
    console.error(`supply-chain: could not read the license inventory: ${error.message}`);
    process.exit(1);
  }
}
