#!/usr/bin/env node
/**
 * Runs the k6 load profile from tools/perf/k6/load.js and stores the raw summary under the
 * git-ignored `artifacts/perf/` directory.
 *
 * Usage:
 *   node tools/perf/run-load.mjs --profile smoke
 *   node tools/perf/run-load.mjs --profile full --duration 300
 *   node tools/perf/run-load.mjs --profile smoke --only jwks --rate-scale 5 --duration 20
 *
 * The k6 binary is used when it is on PATH; otherwise the pinned `grafana/k6` container is
 * used and loopback URLs are translated to `host.docker.internal`.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const scriptDir = resolve(here, 'k6');
const artifactsDir = resolve(repoRoot, 'artifacts', 'perf');
const K6_IMAGE = 'grafana/k6:0.54.0';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }
    const [key, inline] = arg.slice(2).split('=');
    const value = inline ?? argv[index + 1];
    if (inline === undefined) {
      index += 1;
    }
    args[key] = value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const profile = args.profile ?? 'smoke';
const baseUrl = (args['base-url'] ?? process.env.PERF_BASE_URL ?? 'http://127.0.0.1:3100').replace(
  /\/+$/,
  '',
);
const duration = args.duration ?? process.env.DURATION;
const only = args.only ?? process.env.ONLY;
const rateScale = args['rate-scale'] ?? process.env.RATE_SCALE;
const mfeBundleUrl = args['mfe-bundle-url'] ?? process.env.MFE_BUNDLE_URL;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitForHealth(url) {
  const deadline = Date.now() + 60_000;
  let lastError = 'unknown error';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(
    `API is not healthy at ${url}/healthz (${lastError}). Start it with the command in ` +
      'tools/perf/README.md and retry.',
  );
}

function localK6() {
  const probe = spawnSync('k6', ['version'], { encoding: 'utf8' });
  return probe.status === 0 ? 'k6' : null;
}

function printSummary(file) {
  let summary;
  try {
    summary = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  const metrics = summary.metrics ?? {};
  const rows = Object.entries(metrics)
    .filter(([name]) => name.startsWith('http_req_duration{name:'))
    .map(([name, values]) => {
      const endpoint = name.replace(/^http_req_duration\{name:|\}$/g, '');
      return (
        `${endpoint}\tp95=${formatMs(values['p(95)'])}\tp99=${formatMs(values['p(99)'])}\t` +
        `avg=${formatMs(values.avg)}`
      );
    });
  if (rows.length > 0) {
    console.log('\nPer-endpoint latency (actual):');
    console.log(rows.join('\n'));
  }
  const requests = metrics.http_reqs;
  if (requests !== undefined && typeof requests.rate === 'number') {
    console.log(`\nAchieved RPS: ${requests.rate.toFixed(1)} (${requests.count} requests)`);
  }
  const failed = metrics.http_req_failed;
  if (failed !== undefined && typeof failed.rate === 'number') {
    console.log(`Error rate: ${(failed.rate * 100).toFixed(3)}%`);
  }
}

function formatMs(value) {
  return typeof value === 'number' ? `${value.toFixed(2)}ms` : 'n/a';
}

const env = {
  BASE_URL: baseUrl,
  PROFILE: profile,
  ...(duration === undefined ? {} : { DURATION: String(duration) }),
  ...(only === undefined ? {} : { ONLY: String(only) }),
  ...(rateScale === undefined ? {} : { RATE_SCALE: String(rateScale) }),
  ...(mfeBundleUrl === undefined ? {} : { MFE_BUNDLE_URL: String(mfeBundleUrl) }),
};

mkdirSync(artifactsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const summaryName = `${profile}-${stamp}.json`;
const summaryPath = resolve(artifactsDir, summaryName);

const needsApi =
  only === undefined ||
  only
    .split(',')
    .map((value) => value.trim())
    .some((value) => value !== '' && value !== 'mfe_remote');

if (needsApi) {
  await waitForHealth(baseUrl);
}
if (mfeBundleUrl !== undefined) {
  try {
    const response = await fetch(mfeBundleUrl, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    throw new Error(
      `MFE bundle is not reachable at ${mfeBundleUrl} (${
        error instanceof Error ? error.message : String(error)
      }). Build and preview it as documented in tools/perf/README.md.`,
      { cause: error },
    );
  }
}

const k6 = localK6();
let result;
if (k6 !== null) {
  result = spawnSync(
    k6,
    ['run', '--quiet', '--summary-export', summaryPath, resolve(scriptDir, 'load.js')],
    { env: { ...process.env, ...env }, stdio: 'inherit' },
  );
} else {
  // On Linux the container can share the host network, so a loopback-bound API is reachable
  // without exposing it. Docker Desktop (Windows/macOS) uses the special host alias instead.
  const useHostNetwork = process.platform === 'linux';
  const containerBase = useHostNetwork
    ? baseUrl
    : (process.env.PERF_CONTAINER_BASE_URL ??
      baseUrl.replace(/\/\/(127\.0\.0\.1|localhost)(?=[:/]|$)/, '//host.docker.internal'));
  const dockerArgs = [
    'run',
    '--rm',
    ...(useHostNetwork ? ['--network', 'host'] : []),
    '-v',
    `${scriptDir}:/scripts`,
    '-v',
    `${artifactsDir}:/results`,
    '-e',
    `BASE_URL=${containerBase}`,
    '-e',
    `PROFILE=${env.PROFILE}`,
  ];
  for (const key of ['DURATION', 'ONLY', 'RATE_SCALE']) {
    if (env[key] !== undefined) {
      dockerArgs.push('-e', `${key}=${env[key]}`);
    }
  }
  if (mfeBundleUrl !== undefined) {
    const remoteUrl = useHostNetwork
      ? mfeBundleUrl
      : mfeBundleUrl.replace(/\/\/(127\.0\.0\.1|localhost)(?=[:/]|$)/, '//host.docker.internal');
    dockerArgs.push('-e', `MFE_BUNDLE_URL=${remoteUrl}`);
  }
  dockerArgs.push(
    K6_IMAGE,
    'run',
    '--quiet',
    '--summary-export',
    `/results/${summaryName}`,
    '/scripts/load.js',
  );
  console.log(`k6 not found on PATH; using ${K6_IMAGE} (API reached as ${containerBase}).`);
  result = spawnSync('docker', dockerArgs, { stdio: 'inherit' });
}

if (result.error !== undefined) {
  console.error(`Failed to start k6: ${result.error.message}`);
  process.exit(1);
}
printSummary(summaryPath);
console.log(`\nSummary written to ${summaryPath}`);
if (result.status !== 0) {
  console.error(
    `\nk6 exited with ${result.status}: a documented threshold was crossed. ` +
      'See the per-endpoint rows above; do not raise a threshold without an agreed SLO change.',
  );
}
process.exit(result.status ?? 1);
