#!/usr/bin/env node
/**
 * Generates a CycloneDX 1.5 SBOM from pnpm-lock.yaml plus the installed license
 * inventory (`pnpm licenses list --json`).
 *
 * Usage: node tools/sbom.mjs [--out artifacts/sbom.cdx.json]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Runs the pnpm CLI through the same Node binary that runs this script. */
function runPnpm(args) {
  const execPath = process.env.npm_execpath;
  const options = {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  };
  if (execPath !== undefined && execPath !== '') {
    return execFileSync(process.execPath, [execPath, ...args], options);
  }
  return execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
    ...options,
    shell: process.platform === 'win32',
  });
}

const outIndex = process.argv.indexOf('--out');
const outputPath = resolve(
  ROOT,
  outIndex === -1 ? 'artifacts/sbom.cdx.json' : process.argv[outIndex + 1],
);

const rootPackage = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const lockfile = parse(readFileSync(resolve(ROOT, 'pnpm-lock.yaml'), 'utf8'));

/** `name@version` keys may carry peer suffixes: react@19.3.1(react@19.3.1). */
function splitPackageKey(key) {
  const withoutPeers = key.split('(')[0];
  const at = withoutPeers.lastIndexOf('@');
  if (at <= 0) {
    return null;
  }
  return { name: withoutPeers.slice(0, at), version: withoutPeers.slice(at + 1) };
}

function encodeName(name) {
  return name.startsWith('@')
    ? `%40${name.slice(1).replace('/', '%2F')}`
    : encodeURIComponent(name);
}

let licenseInventory = {};
try {
  licenseInventory = JSON.parse(runPnpm(['licenses', 'list', '--json']));
} catch (error) {
  console.error('warning: could not read the license inventory:', error.message);
}

/** `${name}@${version}` -> license string. */
const licenses = new Map();
for (const [license, entries] of Object.entries(licenseInventory)) {
  for (const entry of entries) {
    for (const version of entry.versions ?? []) {
      licenses.set(`${entry.name}@${version}`, entry.license ?? license);
    }
  }
}

const packages = lockfile?.packages ?? {};
const components = [];
const seen = new Set();

for (const [key, meta] of Object.entries(packages)) {
  const parsed = splitPackageKey(key);
  if (parsed === null) {
    continue;
  }
  const { name, version } = parsed;
  const purl = `pkg:npm/${encodeName(name)}@${version}`;
  if (seen.has(purl)) {
    continue;
  }
  seen.add(purl);

  const integrity = meta?.resolution?.integrity;
  const component = {
    type: 'library',
    'bom-ref': purl,
    name,
    version,
    purl,
  };
  if (integrity?.startsWith('sha512-')) {
    component.hashes = [{ alg: 'SHA-512', content: integrity.slice('sha512-'.length) }];
  }
  const license = licenses.get(`${name}@${version}`);
  if (license !== undefined) {
    component.licenses = [{ license: { id: license } }];
  }
  components.push(component);
}

components.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'on4net', name: 'idpn-sbom', version: '1.0.0' }],
    component: {
      type: 'application',
      'bom-ref': `pkg:npm/${rootPackage.name}@${rootPackage.version}`,
      name: rootPackage.name,
      version: rootPackage.version,
    },
  },
  components,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
console.log(`SBOM written to ${outputPath} (${components.length} components)`);
