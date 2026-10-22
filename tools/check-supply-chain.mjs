#!/usr/bin/env node
/**
 * Supply-chain guards for the design system:
 *  1. every shipped (`dependencies`) entry of every workspace manifest must be an exact
 *     version (or a `workspace:`/`link:`/`file:` local reference);
 *  2. React and ReactDOM must be one identical version across the workspace (MFE singleton);
 *  3. the approved license allowlist must cover every **production** dependency
 *     (dev-only tooling is recorded in the SBOM but never shipped).
 *
 * Usage: node tools/check-supply-chain.mjs [--licenses]
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

/**
 * `--root <dir>` points the checks at a fixture instead of the repository. The failure paths
 * must be exercised by a test that is expected to fail, otherwise a broken guard looks green
 * forever (card #71 finding 4).
 */
const rootArgument = process.argv.indexOf('--root');
const ROOT =
  rootArgument === -1
    ? resolve(dirname(fileURLToPath(import.meta.url)), '..')
    : resolve(process.argv[rootArgument + 1] ?? '.');

/** Dependencies that must never float, even in `devDependencies`. */
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
/** Local workspace references are not published, so their range syntax is irrelevant. */
const LOCAL_REFERENCE = /^(?:workspace|link|file):/;
const problems = [];

/**
 * Every workspace manifest, discovered from `pnpm-workspace.yaml` instead of a hardcoded
 * list: a new package under `packages/*` or `examples/*` is scanned automatically
 * (card #71 finding 4).
 */
const packageFiles = discoverManifests();

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
      if (LOCAL_REFERENCE.test(version)) {
        continue;
      }
      // A shipped dependency always needs an exact version; the design-system pins must hold
      // even in devDependencies.
      if ((section === 'dependencies' || PINNED.includes(name)) && !EXACT_VERSION.test(version)) {
        problems.push(
          `${file}: ${name} must be pinned to an exact version in ${section}, found "${version}"`,
        );
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
  const directCount = manifests.reduce(
    (total, { pkg }) => total + Object.keys(pkg.dependencies ?? {}).length,
    0,
  );
  // A closure that is not larger than the direct dependency set means the graph walk stopped
  // at the first level (the lockfile v9 `packages`/`snapshots` trap, card #71 finding 3).
  if (productionVersions.size <= directCount) {
    problems.push(
      `production closure (${productionVersions.size}) is not larger than the direct dependency ` +
        `count (${directCount}); the lockfile graph was not walked`,
    );
  }
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
  `Supply-chain check passed: ${PINNED.length} pinned packages, react ${[
    ...reactVersions,
  ].join('/')}, ${manifests.length} manifests${
    process.argv.includes('--licenses') ? `, ${productionClosure().size} shipped packages` : ''
  }`,
);

function isAllowedLicense(license) {
  return license
    .split(/\s+(?:AND|OR)\s+|\//i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .every((part) => ALLOWED_LICENSES.has(part));
}

/** Expands `pnpm-workspace.yaml` patterns into the list of workspace manifests. */
function discoverManifests() {
  const workspace = parse(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8'));
  const patterns = workspace.packages ?? [];
  const files = new Set([join(ROOT, 'package.json')]);

  for (const pattern of patterns) {
    const normalised = String(pattern).replace(/\/+$/, '');
    if (normalised.endsWith('*')) {
      const parent = join(ROOT, normalised.slice(0, -1));
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          // Only directories that are really workspace packages.
          const candidate = join(parent, entry.name, 'package.json');
          try {
            readFileSync(candidate);
            files.add(candidate);
          } catch {
            continue;
          }
        }
      }
      continue;
    }
    const candidate = join(ROOT, normalised, 'package.json');
    try {
      readFileSync(candidate);
      files.add(candidate);
    } catch {
      problems.push(`workspace entry "${normalised}" has no package.json`);
    }
  }

  return [...files];
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

/**
 * Walks every importer's production dependencies and returns `name@version` entries.
 *
 * lockfile v9 keeps dependency edges in `snapshots`, not in `packages` — walking `packages`
 * alone resolved ~20 of ~318 shipped packages and never licence-checked the rest
 * (card #71 finding 3). A key that cannot be resolved is an error: silently skipping it
 * would reintroduce the same blind spot.
 */
export function productionClosure(lockfilePath = join(ROOT, 'pnpm-lock.yaml')) {
  const lockfile = parse(readFileSync(lockfilePath, 'utf8'));
  const graph = lockfile.snapshots ?? lockfile.packages ?? {};
  const byId = new Map();
  for (const [key, entry] of Object.entries(graph)) {
    const parsed = splitKey(key);
    if (parsed === null) {
      continue;
    }
    byId.set(`${parsed.name}@${parsed.version}`, entry ?? {});
  }

  // Packages that only ever appear as devDependencies are tooling (the Prisma CLI, its studio
  // UI and their transitive peers). They are reachable from a production package through a
  // peer edge but are never bundled or installed for a production deployment.
  const runtimeNames = new Set();
  const devOnlyNames = new Set();
  for (const importer of Object.values(lockfile.importers ?? {})) {
    for (const name of Object.keys(importer.dependencies ?? {})) {
      runtimeNames.add(name);
    }
    for (const name of Object.keys(importer.devDependencies ?? {})) {
      devOnlyNames.add(name);
    }
  }
  for (const name of runtimeNames) {
    devOnlyNames.delete(name);
  }

  const seen = new Set();
  const queue = [];
  const unresolved = new Set();
  for (const importer of Object.values(lockfile.importers ?? {})) {
    for (const [name, spec] of Object.entries(importer.dependencies ?? {})) {
      const version = spec?.version;
      if (version === undefined) {
        continue;
      }
      if (/^(?:link|file|workspace):/.test(String(version))) {
        continue;
      }
      queue.push(`${name}@${String(version).split('(')[0]}`);
    }
  }

  while (queue.length > 0) {
    const id = queue.pop();
    if (seen.has(id)) {
      continue;
    }
    const parsedId = splitKey(id);
    if (parsedId !== null && devOnlyNames.has(parsedId.name)) {
      continue;
    }
    seen.add(id);
    const entry = byId.get(id);
    if (entry === undefined) {
      unresolved.add(id);
      continue;
    }
    for (const section of ['dependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(entry[section] ?? {})) {
        const value = String(version);
        if (/^(?:link|file|workspace):/.test(value)) {
          continue;
        }
        queue.push(`${name}@${value.split('(')[0]}`);
      }
    }
  }

  if (unresolved.size > 0) {
    problems.push(
      `cannot resolve ${unresolved.size} shipped package(s) in the lockfile: ${[
        ...unresolved,
      ].join(', ')}`,
    );
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
