import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';

import { createAccountLifecycle } from '../src/account/lifecycle.js';
import { createPrismaLifecycleUserStore } from '../src/account/prisma-lifecycle-repository.js';
import { createPrismaAccountTokenStore } from '../src/account/prisma-token-repository.js';
import { createPrismaMemberRepository } from '../src/admin/members/prisma-member-repository.js';
import { createPrismaRbacRepository } from '../src/admin/rbac/prisma-rbac-repository.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createMailer } from '../src/mail/index.js';
import {
  createPrismaImportRollbackPorts,
  createPrismaUserImportPorts,
  resolveImportActor,
} from '../src/onboarding/prisma-import-port.js';
import { productionConfirmationProblem } from '../src/onboarding/social-credentials.js';
import {
  parseImportSummary,
  parseUserCsv,
  parseUserJson,
  rollbackUserImport,
  runUserImport,
  type ImportSummary,
} from '../src/onboarding/user-import.js';
import {
  flagValue,
  flagValues,
  hasFlag,
  parseArgs,
  readJsonFile,
  requiredFlag,
  writeJsonFile,
} from './cli-args.js';

/**
 * Imports existing users of an app (`docs/runbooks/app-onboarding.md`).
 *
 *   tsx scripts/import-users.ts import --client platform-a --file users.csv \
 *     --actor admin@example.com [--mail invite|verification|none] [--resend-mail]
 *     [--mail-rate 30] [--dry-run] [--summary artifacts/onboarding/users.json] [--confirm]
 *   tsx scripts/import-users.ts rollback --summary <file> [--keep-users] [--dry-run]
 *
 * Created users always have `password_hash = NULL`: access is granted through a single-use
 * invite (set password) or verification link sent by the existing account lifecycle.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..');

const USAGE = `usage:
  import-users.ts import --client <clientId> [--client <clientId>...] --file <users.csv|users.json>
                         --actor <operator@example.com> [--mail invite|verification|none]
                         [--resend-mail] [--mail-rate <emails-per-minute>] [--dry-run]
                         [--summary <file>] [--confirm]
  import-users.ts rollback --summary <file> [--keep-users] [--dry-run] [--confirm]

environment:
  DATABASE_URL   target database
  APP_URL        Hosted UI base for the invite/verification links (HOSTED_UI_URL wins)
  SMTP_URL       when unset no mail leaves the process
  NODE_ENV       production requires --confirm`;

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

function uiBaseUrl(): string {
  const value =
    process.env['HOSTED_UI_URL'] !== undefined && process.env['HOSTED_UI_URL'] !== ''
      ? process.env['HOSTED_UI_URL']
      : process.env['APP_URL'];
  if (value === undefined || value === '') {
    fail('APP_URL (or HOSTED_UI_URL) is required to build the invite links.');
  }
  return value;
}

const defaultSummaryPath = (clientId: string, now: Date): string => {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return resolve(REPO_ROOT, 'artifacts', 'onboarding', `import-${clientId}-${stamp}.json`);
};

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
  const rbac = createPrismaRbacRepository(prisma);
  const members = createPrismaMemberRepository(prisma, { rbac });
  const dryRun = hasFlag(args, 'dry-run');

  try {
    if (args.command === 'rollback') {
      const summaryPath = requiredFlag(args, 'summary', 'import summary written by the import');
      const parsed = parseImportSummary(await readJsonFile(summaryPath));
      if (!parsed.ok || parsed.summary === null) {
        fail(`invalid import summary:\n  ${parsed.problems.join('\n  ')}`);
      }
      const result = await rollbackUserImport({
        summary: parsed.summary,
        ports: createPrismaImportRollbackPorts(prisma, { members }),
        dryRun,
        keepUsers: hasFlag(args, 'keep-users'),
      });
      const out = flagValue(args, 'out');
      if (out !== undefined) {
        await writeJsonFile(out, result);
      }
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (args.command !== 'import') {
      fail(USAGE);
    }

    const clients = flagValues(args, 'client');
    if (clients.length === 0) {
      fail('--client is required at least once.');
    }
    const file = requiredFlag(args, 'file', 'CSV or JSON file with the users to migrate');
    const format =
      flagValue(args, 'format') ?? (extname(file).toLowerCase() === '.json' ? 'json' : 'csv');

    const content = await readFile(file, 'utf8');
    const parseOptions = { allowedClients: clients, defaultClient: clients[0]! };
    const parsedImport =
      format === 'json'
        ? parseUserJson(JSON.parse(content) as unknown, parseOptions)
        : parseUserCsv(content, parseOptions);

    const mailMode = flagValue(args, 'mail') ?? 'invite';
    if (mailMode !== 'invite' && mailMode !== 'verification' && mailMode !== 'none') {
      fail('--mail must be one of invite, verification, none.');
    }
    const rate = Number(flagValue(args, 'mail-rate') ?? '30');
    if (!Number.isFinite(rate) || rate < 0) {
      fail('--mail-rate must be a non-negative number of emails per minute (0 disables).');
    }

    let actorId = '';
    if (!dryRun) {
      const actor = requiredFlag(args, 'actor', 'e-mail of the operator account');
      actorId = await resolveImportActor(prisma, actor);
    }

    const mailer = createMailer({
      SMTP_URL: process.env['SMTP_URL'],
      MAIL_FROM: process.env['MAIL_FROM'] ?? 'no-reply@on4net.dev',
    });
    const lifecycle = createAccountLifecycle({
      users: createPrismaLifecycleUserStore(prisma),
      tokens: createPrismaAccountTokenStore(prisma),
      mailer,
      links: { uiBaseUrl: uiBaseUrl() },
    });

    const summary: ImportSummary = await runUserImport({
      parsed: parsedImport,
      allowedClients: clients,
      actorId,
      mailMode,
      resendMail: hasFlag(args, 'resend-mail'),
      dryRun,
      mailIntervalMs: rate === 0 ? 0 : Math.ceil(60_000 / rate),
      ports: createPrismaUserImportPorts(prisma, { members, lifecycle }),
    });

    const summaryPath = flagValue(args, 'summary') ?? defaultSummaryPath(clients[0]!, new Date());
    await writeJsonFile(summaryPath, summary);
    console.log(JSON.stringify({ ...summary, summaryPath }, null, 2));
    process.exitCode = summary.totals.error > 0 ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
