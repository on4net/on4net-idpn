import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';

import { createPrismaRbacRepository } from '../src/admin/rbac/prisma-rbac-repository.js';
import { createPrismaSocialProviderRepository } from '../src/admin/social-providers/prisma-social-provider-repository.js';
import { loadSocialSecretKey, createSecretBox, SecretBoxError } from '../src/crypto/secret-box.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { parseAppOnboardingConfig } from '../src/onboarding/app-config.js';
import {
  applyClientOnboarding,
  mergeOnboardingState,
  parseClientOnboardingState,
  rollbackClientOnboarding,
  type ClientOnboardingState,
} from '../src/onboarding/client-onboarding.js';
import {
  combineCredentialLookups,
  createEnvCredentialLookup,
  parseSecretsFile,
  productionConfirmationProblem,
  resolveCallbackBase,
  type SecretsFile,
} from '../src/onboarding/social-credentials.js';
import {
  flagValue,
  hasFlag,
  parseArgs,
  readJsonFile,
  requiredFlag,
  writeJsonFile,
} from './cli-args.js';

/**
 * Registers one app: per-app social provider credentials plus its permission/role mapping.
 *
 *   tsx scripts/onboard-client.ts apply --config examples/onboarding/platform-a.json \
 *     --secrets-file ./platform-a.secrets.json [--dry-run] [--confirm]
 *   tsx scripts/onboard-client.ts rollback --state artifacts/onboarding/platform-a.json \
 *     [--dry-run] [--confirm]
 *
 * Credentials come from a non-committed source (environment variables or a secrets file) and
 * are encrypted with the same AES-256-GCM secret box the Admin API uses. The summary contains
 * a masked client-id hint only; a secret is never printed, logged or written to the state.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..');

const USAGE = `usage:
  onboard-client.ts apply --config <file> [--secrets-file <file>] [--issuer <url>]
                          [--skip-social] [--dry-run] [--confirm]
                          [--summary <file>] [--state <file>] [--no-state]
  onboard-client.ts rollback --state <file> [--dry-run] [--confirm] [--summary <file>]

environment:
  DATABASE_URL          target database (staging/production explicitly, never by accident)
  SOCIAL_CALLBACK_BASE_URL / APP_URL
                        base used to derive the exact provider callback
  NODE_ENV              production requires --confirm
  SOCIAL_SECRET_KEY     base64 of 32 bytes; required to store a provider secret`;

function loadEnvironment(): void {
  loadEnv({ path: resolve(here, '..', '.env'), quiet: true });
  loadEnv({ path: resolve(here, '..', '..', '.env'), quiet: true });
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function databaseUrl(): string {
  const value = process.env['DATABASE_URL'];
  if (value === undefined || value === '') {
    fail('DATABASE_URL is not set. Copy .env.example to .env first.');
  }
  return value;
}

async function main(): Promise<void> {
  loadEnvironment();
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help' || hasFlag(args, 'help')) {
    console.log(USAGE);
    return;
  }

  const nodeEnv = process.env['NODE_ENV'];
  const confirmationProblem = productionConfirmationProblem(nodeEnv, hasFlag(args, 'confirm'));
  if (confirmationProblem !== null) {
    fail(confirmationProblem);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl() }) });
  const providers = createPrismaSocialProviderRepository(prisma);
  const rbac = createPrismaRbacRepository(prisma);

  try {
    if (args.command === 'rollback') {
      const statePath = requiredFlag(args, 'state', 'state file written by a previous apply');
      const parsedState = parseClientOnboardingState(await readJsonFile(statePath));
      if (!parsedState.ok || parsedState.state === null) {
        fail(`invalid state file:\n  ${parsedState.problems.join('\n  ')}`);
      }
      const result = await rollbackClientOnboarding(
        { state: parsedState.state, dryRun: hasFlag(args, 'dry-run') },
        {
          providers,
          rbac,
          secretBox: null,
          issuer: parsedState.state.issuer,
          credentials: () => null,
          nodeEnv,
        },
      );
      const summaryPath = flagValue(args, 'summary');
      if (summaryPath !== undefined) {
        await writeJsonFile(summaryPath, result);
      }
      console.log(JSON.stringify({ command: 'rollback', state: statePath, ...result }, null, 2));
      process.exitCode = result.problems.length > 0 ? 1 : 0;
      return;
    }

    if (args.command !== 'apply') {
      fail(USAGE);
    }

    const configPath = requiredFlag(args, 'config', 'app onboarding document');
    const parsedConfig = parseAppOnboardingConfig(await readJsonFile(configPath));
    if (!parsedConfig.ok || parsedConfig.config === null) {
      fail(`invalid onboarding config:\n  ${parsedConfig.problems.join('\n  ')}`);
    }
    const config = parsedConfig.config;

    const secretsPath = flagValue(args, 'secrets-file');
    let secrets: SecretsFile | null = null;
    if (secretsPath !== undefined) {
      const parsedSecrets = parseSecretsFile(await readJsonFile(secretsPath));
      if (!parsedSecrets.ok) {
        fail(`invalid secrets file:\n  ${parsedSecrets.problems.join('\n  ')}`);
      }
      secrets = parsedSecrets.secrets;
    }
    const overrides = Object.fromEntries(
      Object.entries(config.socialProviders).map(([provider, value]) => [
        provider,
        {
          ...(value.clientKeyRef === undefined ? {} : { clientKeyRef: value.clientKeyRef }),
          ...(value.clientSecretRef === undefined
            ? {}
            : { clientSecretRef: value.clientSecretRef }),
        },
      ]),
    );
    const credentials = combineCredentialLookups(
      secrets,
      createEnvCredentialLookup(process.env, overrides),
    );

    const issuer = flagValue(args, 'issuer') ?? resolveCallbackBase(process.env);
    if (issuer === undefined || issuer === null || issuer === '') {
      fail(
        '--issuer, SOCIAL_CALLBACK_BASE_URL or APP_URL is required to bind the provider ' +
          'callback URL.',
      );
    }

    let secretBox = null;
    const hasProviders = Object.keys(config.socialProviders).length > 0;
    if (hasProviders && !hasFlag(args, 'skip-social')) {
      try {
        const key = loadSocialSecretKey({
          NODE_ENV: nodeEnv,
          SOCIAL_SECRET_KEY: process.env['SOCIAL_SECRET_KEY'],
        });
        secretBox = key === null ? null : createSecretBox(key);
      } catch (error) {
        if (error instanceof SecretBoxError) {
          fail(`${error.message}. Generate one with: openssl rand -base64 32`);
        }
        throw error;
      }
    }

    const result = await applyClientOnboarding(
      {
        config,
        dryRun: hasFlag(args, 'dry-run'),
        skipSocial: hasFlag(args, 'skip-social'),
      },
      { providers, rbac, secretBox, issuer, credentials, nodeEnv },
    );

    const statePath =
      flagValue(args, 'state') ??
      resolve(REPO_ROOT, 'artifacts', 'onboarding', `${config.clientId}.json`);
    const wroteState = result.state !== null && !hasFlag(args, 'no-state');
    if (wroteState && result.state !== null) {
      // A second run reports everything as pre-existing; keep the first observation so a
      // later rollback still knows what this onboarding created.
      let previous: ClientOnboardingState | null = null;
      try {
        await access(statePath);
        const parsedPrevious = parseClientOnboardingState(await readJsonFile(statePath));
        if (!parsedPrevious.ok || parsedPrevious.state === null) {
          fail(
            `existing state file ${statePath} is invalid; inspect or remove it:\n  ` +
              parsedPrevious.problems.join('\n  '),
          );
        }
        previous = parsedPrevious.state;
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') {
          throw error;
        }
      }
      await writeJsonFile(statePath, mergeOnboardingState(previous, result.state));
    }
    const summaryPath = flagValue(args, 'summary');
    if (summaryPath !== undefined) {
      await writeJsonFile(summaryPath, result);
    }
    console.log(
      JSON.stringify(
        {
          command: 'apply',
          clientId: config.clientId,
          dryRun: result.dryRun,
          problems: result.problems,
          social: result.social,
          mapping: result.mapping,
          statePath: wroteState ? statePath : null,
        },
        null,
        2,
      ),
    );
    process.exitCode = result.problems.length > 0 ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
