import { z } from 'zod';

import { normalizeEmail } from '../auth/normalize.js';
import type {
  InviteMemberInput,
  MemberInviteOutcome,
  MemberResult,
} from '../admin/members/member-types.js';
import { roleKeyProblems } from '../admin/rbac/rbac-validation.js';
import type { InviteDelivery } from '../account/lifecycle.js';

/**
 * Existing-user migration: CSV/JSON import, idempotent and resumable (`docs/runbooks/app-onboarding.md`).
 *
 * A migrated user never receives a local password. The import creates the central user with
 * `password_hash = NULL`, invites the app membership through the existing member repository
 * and lets the existing account lifecycle mail a single-use *invite* link (set password) or a
 * verification link. No code path in this module generates or hashes a password.
 */

export interface ImportMembershipSpec {
  clientId: string;
  roleKeys: string[];
}

export interface ParsedImportRow {
  line: number;
  email: string;
  displayName?: string;
  externalId?: string;
  locale?: string;
  memberships: ImportMembershipSpec[];
}

export interface ImportRowProblem {
  line: number;
  message: string;
}

export interface ParsedUserImport {
  rows: ParsedImportRow[];
  problems: ImportRowProblem[];
}

export interface ImportParseOptions {
  /** Clients this import may add memberships to; anything else is rejected per row. */
  allowedClients: string[];
  /** App used when the row does not declare explicit memberships. */
  defaultClient: string;
}

const MAX_EMAIL_LENGTH = 320;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCALE = /^[a-z]{2}(?:-[A-Z]{2})?$/;

/** RFC 4180 subset parser: quoted fields, doubled quotes, CRLF and a UTF-8 BOM. */
export function parseCsvTable(text: string): {
  header: string[];
  records: { line: number; values: string[] }[];
} {
  const source = text.replace(/^\uFEFF/, '');
  const records: { line: number; values: string[] }[] = [];
  let values: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === undefined) {
      break;
    }
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (character === '\n') {
          line += 1;
        }
        field += character;
      }
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      continue;
    }
    if (character === ',') {
      values.push(field);
      field = '';
      continue;
    }
    if (character === '\r') {
      continue;
    }
    if (character === '\n') {
      values.push(field);
      field = '';
      records.push({ line: recordLine, values });
      values = [];
      line += 1;
      recordLine = line;
      continue;
    }
    field += character;
  }
  if (field !== '' || values.length > 0) {
    values.push(field);
    records.push({ line: recordLine, values });
  }

  const headerRecord = records.shift();
  if (headerRecord === undefined) {
    return { header: [], records: [] };
  }
  return {
    header: headerRecord.values.map((value) => value.trim()),
    records: records.filter((record) => record.values.some((value) => value.trim() !== '')),
  };
}

const HEADER_ALIASES: Record<string, string> = {
  email: 'email',
  mail: 'email',
  displayname: 'displayName',
  name: 'displayName',
  fullname: 'displayName',
  externalid: 'externalId',
  legacyid: 'externalId',
  locale: 'locale',
  language: 'locale',
  rolekeys: 'roleKeys',
  roles: 'roleKeys',
  memberships: 'memberships',
};

const normalizeHeader = (header: string): string => header.toLowerCase().replace(/[\s_-]/g, '');

const splitRoleKeys = (value: string): string[] =>
  value
    .split(/[;|,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface RawRow {
  line: number;
  email?: unknown;
  displayName?: unknown;
  externalId?: unknown;
  locale?: unknown;
  roleKeys?: unknown;
  memberships?: unknown;
}

function readMembershipValue(value: unknown): {
  specs: ImportMembershipSpec[];
  problem: string | null;
} {
  if (value === undefined || value === null || value === '') {
    return { specs: [], problem: null };
  }
  const asList = (entry: unknown): { specs: ImportMembershipSpec[]; problem: string | null } => {
    if (typeof entry === 'string') {
      return { specs: [{ clientId: '', roleKeys: splitRoleKeys(entry) }], problem: null };
    }
    if (isPlainObject(entry)) {
      const clientId = typeof entry['clientId'] === 'string' ? entry['clientId'].trim() : '';
      const roleKeys = Array.isArray(entry['roleKeys'])
        ? entry['roleKeys'].filter((item): item is string => typeof item === 'string')
        : typeof entry['roleKeys'] === 'string'
          ? splitRoleKeys(entry['roleKeys'])
          : [];
      return {
        specs: [{ clientId, roleKeys: roleKeys.map((key) => key.trim()).filter(Boolean) }],
        problem: null,
      };
    }
    return { specs: [], problem: 'memberships entries must be objects with clientId and roleKeys' };
  };

  if (Array.isArray(value)) {
    const specs: ImportMembershipSpec[] = [];
    for (const entry of value) {
      const parsed = asList(entry);
      if (parsed.problem !== null) {
        return { specs: [], problem: parsed.problem };
      }
      specs.push(...parsed.specs);
    }
    return { specs, problem: null };
  }
  if (isPlainObject(value)) {
    const specs: ImportMembershipSpec[] = [];
    for (const [clientId, roleKeys] of Object.entries(value)) {
      if (typeof roleKeys === 'string') {
        specs.push({ clientId, roleKeys: splitRoleKeys(roleKeys) });
      } else if (Array.isArray(roleKeys)) {
        specs.push({
          clientId,
          roleKeys: roleKeys.filter((key): key is string => typeof key === 'string'),
        });
      } else {
        return { specs: [], problem: `memberships.${clientId} must be a list of role keys` };
      }
    }
    return { specs, problem: null };
  }
  if (typeof value === 'string') {
    try {
      return readMembershipValue(JSON.parse(value));
    } catch {
      return { specs: [], problem: 'memberships must be valid JSON' };
    }
  }
  return { specs: [], problem: 'memberships has an unsupported shape' };
}

interface ValidatedRow {
  row: ParsedImportRow | null;
  problem: string | null;
}

function validateRawRow(raw: RawRow, options: ImportParseOptions): ValidatedRow {
  const emailValue = typeof raw.email === 'string' ? normalizeEmail(raw.email) : '';
  if (emailValue === '' || emailValue.length > MAX_EMAIL_LENGTH || !EMAIL.test(emailValue)) {
    return { row: null, problem: 'email is missing or invalid' };
  }

  const displayName =
    typeof raw.displayName === 'string' && raw.displayName.trim() !== ''
      ? raw.displayName.trim().slice(0, 120)
      : undefined;
  const externalId =
    typeof raw.externalId === 'string' && raw.externalId.trim() !== ''
      ? raw.externalId.trim().slice(0, 190)
      : undefined;
  const locale =
    typeof raw.locale === 'string' && raw.locale.trim() !== '' ? raw.locale.trim() : undefined;
  if (locale !== undefined && !LOCALE.test(locale)) {
    return { row: null, problem: `locale "${locale}" must look like fa-IR or en` };
  }

  const roleKeys = Array.isArray(raw.roleKeys)
    ? raw.roleKeys.filter((key): key is string => typeof key === 'string')
    : typeof raw.roleKeys === 'string'
      ? splitRoleKeys(raw.roleKeys)
      : [];

  const explicit = readMembershipValue(raw.memberships);
  if (explicit.problem !== null) {
    return { row: null, problem: explicit.problem };
  }
  const memberships: ImportMembershipSpec[] =
    explicit.specs.length > 0
      ? explicit.specs.map((spec) => ({
          clientId: spec.clientId === '' ? options.defaultClient : spec.clientId,
          roleKeys: [...new Set(spec.roleKeys)].sort(),
        }))
      : [{ clientId: options.defaultClient, roleKeys: [...new Set(roleKeys)].sort() }];

  for (const membership of memberships) {
    if (!options.allowedClients.includes(membership.clientId)) {
      return {
        row: null,
        problem: `client "${membership.clientId}" is not allowed for this import`,
      };
    }
    for (const key of membership.roleKeys) {
      const problems = roleKeyProblems(key, membership.clientId);
      if (problems.length > 0) {
        return { row: null, problem: `role "${key}": ${problems.join('; ')}` };
      }
    }
  }

  return {
    row: {
      line: raw.line,
      email: emailValue,
      ...(displayName === undefined ? {} : { displayName }),
      ...(externalId === undefined ? {} : { externalId }),
      ...(locale === undefined ? {} : { locale }),
      memberships,
    },
    problem: null,
  };
}

/** Rejects duplicate rows inside one file (same e-mail or same legacy id). */
function markDuplicates(result: ParsedUserImport): ParsedUserImport {
  const emails = new Map<string, number>();
  const externalIds = new Map<string, number>();
  const rows: ParsedImportRow[] = [];
  const problems = [...result.problems];
  for (const row of result.rows) {
    const emailLine = emails.get(row.email);
    if (emailLine !== undefined) {
      problems.push({
        line: row.line,
        message: `duplicate-row: email "${row.email}" already appears on line ${emailLine}`,
      });
      continue;
    }
    if (row.externalId !== undefined) {
      const idLine = externalIds.get(row.externalId);
      if (idLine !== undefined) {
        problems.push({
          line: row.line,
          message: `duplicate-row: externalId "${row.externalId}" already appears on line ${idLine}`,
        });
        continue;
      }
      externalIds.set(row.externalId, row.line);
    }
    emails.set(row.email, row.line);
    rows.push(row);
  }
  return { rows, problems };
}

/** Parses a CSV document. `line` follows the physical file line of the record. */
export function parseUserCsv(content: string, options: ImportParseOptions): ParsedUserImport {
  const table = parseCsvTable(content);
  if (table.header.length === 0) {
    return { rows: [], problems: [{ line: 1, message: 'header row is missing' }] };
  }
  const columns = new Map<string, number>();
  const problems: ImportRowProblem[] = [];
  table.header.forEach((header, index) => {
    const field = HEADER_ALIASES[normalizeHeader(header)];
    if (field === undefined) {
      problems.push({ line: 1, message: `unknown column "${header}"` });
      return;
    }
    columns.set(field, index);
  });

  const rows: ParsedImportRow[] = [];
  for (const record of table.records) {
    const value = (field: string): unknown => {
      const index = columns.get(field);
      return index === undefined ? undefined : record.values[index];
    };
    const validated = validateRawRow(
      {
        line: record.line,
        email: value('email'),
        displayName: value('displayName'),
        externalId: value('externalId'),
        locale: value('locale'),
        roleKeys: value('roleKeys'),
        memberships: value('memberships'),
      },
      options,
    );
    if (validated.row === null) {
      problems.push({ line: record.line, message: validated.problem ?? 'invalid row' });
    } else {
      rows.push(validated.row);
    }
  }
  return markDuplicates({ rows, problems });
}

/** Parses a JSON document: an array of rows or `{ "users": [...] }`. */
export function parseUserJson(value: unknown, options: ImportParseOptions): ParsedUserImport {
  const list = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value['users'])
      ? value['users']
      : null;
  if (list === null) {
    return { rows: [], problems: [{ line: 1, message: 'expected an array of users' }] };
  }

  const rows: ParsedImportRow[] = [];
  const problems: ImportRowProblem[] = [];
  list.forEach((entry, index) => {
    const line = index + 1;
    if (!isPlainObject(entry)) {
      problems.push({ line, message: 'user entry must be an object' });
      return;
    }
    const pick = (snake: string, camel: string): unknown =>
      entry[camel] !== undefined ? entry[camel] : entry[snake];
    const validated = validateRawRow(
      {
        line,
        email: pick('email', 'email'),
        displayName: pick('display_name', 'displayName'),
        externalId: pick('external_id', 'externalId'),
        locale: pick('locale', 'locale'),
        roleKeys: pick('role_keys', 'roleKeys'),
        memberships: pick('memberships', 'memberships'),
      },
      options,
    );
    if (validated.row === null) {
      problems.push({ line, message: validated.problem ?? 'invalid row' });
    } else {
      rows.push(validated.row);
    }
  });
  return markDuplicates({ rows, problems });
}

export type ImportRowStatus = 'created' | 'linked' | 'skipped' | 'error';
export type ImportMailOutcome =
  'invitation' | 'notification' | 'verification' | 'skipped' | 'failed' | 'not-sent';

export interface ImportMembershipOutcome {
  clientId: string;
  action: 'created' | 'exists' | 'error';
  membershipId?: string;
  roleKeys: string[];
  detail?: string;
}

export interface ImportRowOutcome {
  line: number;
  email: string | null;
  externalId: string | null;
  userId: string | null;
  status: ImportRowStatus;
  reason?: string;
  memberships: ImportMembershipOutcome[];
  mail: ImportMailOutcome;
}

export interface ImportTotals {
  rows: number;
  created: number;
  linked: number;
  skipped: number;
  error: number;
  mailSent: number;
  mailFailed: number;
}

/** Machine-readable import report; also the rollback input. */
export interface ImportSummary {
  version: 1;
  generatedAt: string;
  dryRun: boolean;
  mailMode: 'invite' | 'verification' | 'none';
  clients: string[];
  totals: ImportTotals;
  rows: ImportRowOutcome[];
}

const summarySchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().min(1),
  dryRun: z.boolean(),
  mailMode: z.enum(['invite', 'verification', 'none']),
  clients: z.array(z.string()),
  totals: z.object({
    rows: z.number().int(),
    created: z.number().int(),
    linked: z.number().int(),
    skipped: z.number().int(),
    error: z.number().int(),
    mailSent: z.number().int(),
    mailFailed: z.number().int(),
  }),
  rows: z.array(
    z.object({
      line: z.number().int(),
      email: z.string().nullable(),
      externalId: z.string().nullable(),
      userId: z.string().nullable(),
      status: z.enum(['created', 'linked', 'skipped', 'error']),
      reason: z.string().optional(),
      memberships: z.array(
        z.object({
          clientId: z.string().min(1),
          action: z.enum(['created', 'exists', 'error']),
          membershipId: z.string().optional(),
          roleKeys: z.array(z.string()),
          detail: z.string().optional(),
        }),
      ),
      mail: z.enum(['invitation', 'notification', 'verification', 'skipped', 'failed', 'not-sent']),
    }),
  ),
});

export interface SummaryParseResult {
  ok: boolean;
  summary: ImportSummary | null;
  problems: string[];
}

/** Validates a summary file before a rollback touches the database. */
export function parseImportSummary(value: unknown): SummaryParseResult {
  const parsed = summarySchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      summary: null,
      problems: parsed.error.issues.map((issue) => {
        const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
        return `${path}: ${issue.message}`;
      }),
    };
  }
  return { ok: true, summary: parsed.data, problems: [] };
}

export interface ImportUserRef {
  id: string;
  hasPassword: boolean;
}

export interface UserImportPorts {
  findUser(email: string): Promise<ImportUserRef | null>;
  findMembership(
    clientId: string,
    userId: string,
  ): Promise<{ membershipId: string; status: string } | null>;
  invite(clientId: string, input: InviteMemberInput): Promise<MemberResult<MemberInviteOutcome>>;
  sendInvite(userId: string): Promise<InviteDelivery>;
  sendVerification(userId: string): Promise<boolean>;
}

export interface UserImportOptions {
  parsed: ParsedUserImport;
  allowedClients: string[];
  /** User id recorded as `invited_by` on created memberships and assignments. */
  actorId: string;
  mailMode?: 'invite' | 'verification' | 'none';
  /** Re-send mail for rows that were already imported (resume after a mail outage). */
  resendMail?: boolean;
  dryRun?: boolean;
  /** Minimum spacing between two mails, in milliseconds (`--mail-rate` per minute). */
  mailIntervalMs?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  ports: UserImportPorts;
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const totalsOf = (rows: ImportRowOutcome[]): ImportTotals => ({
  rows: rows.length,
  created: rows.filter((row) => row.status === 'created').length,
  linked: rows.filter((row) => row.status === 'linked').length,
  skipped: rows.filter((row) => row.status === 'skipped').length,
  error: rows.filter((row) => row.status === 'error').length,
  mailSent: rows.filter(
    (row) =>
      row.mail === 'invitation' || row.mail === 'notification' || row.mail === 'verification',
  ).length,
  mailFailed: rows.filter((row) => row.mail === 'failed').length,
});

/**
 * Runs the import. Every row yields exactly one outcome; a failure is recorded and the run
 * continues, so a large file never stops on one bad address.
 */
export async function runUserImport(options: UserImportOptions): Promise<ImportSummary> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const dryRun = options.dryRun ?? false;
  const mailMode = options.mailMode ?? 'invite';
  const interval = Math.max(0, options.mailIntervalMs ?? 0);

  const outcomes: ImportRowOutcome[] = options.parsed.problems.map((problem) => ({
    line: problem.line,
    email: null,
    externalId: null,
    userId: null,
    status: 'error',
    reason: problem.message,
    memberships: [],
    mail: 'not-sent',
  }));

  let lastMailAt: number | null = null;
  const throttle = async (): Promise<void> => {
    if (interval === 0) {
      return;
    }
    if (lastMailAt !== null) {
      const elapsed = now().getTime() - lastMailAt;
      if (elapsed < interval) {
        await sleep(interval - elapsed);
      }
    }
    lastMailAt = now().getTime();
  };

  for (const row of options.parsed.rows) {
    const outcome: ImportRowOutcome = {
      line: row.line,
      email: row.email,
      externalId: row.externalId ?? null,
      userId: null,
      status: 'created',
      memberships: [],
      mail: 'not-sent',
    };

    const existing = await options.ports.findUser(row.email);
    if (dryRun) {
      outcome.userId = existing?.id ?? null;
      for (const membership of row.memberships) {
        const current =
          existing === null
            ? null
            : await options.ports.findMembership(membership.clientId, existing.id);
        outcome.memberships.push({
          clientId: membership.clientId,
          action: current === null ? 'created' : 'exists',
          roleKeys: membership.roleKeys,
          ...(current === null ? {} : { membershipId: current.membershipId }),
        });
      }
      if (existing !== null && outcome.memberships.every((item) => item.action === 'exists')) {
        outcome.status = 'skipped';
      } else {
        outcome.status = existing === null ? 'created' : 'linked';
      }
      outcomes.push(outcome);
      continue;
    }

    let createdUser = false;
    let firstUserId: string | null = existing?.id ?? null;
    const failures: string[] = [];

    for (const membership of row.memberships) {
      const invited = await options.ports.invite(membership.clientId, {
        email: row.email,
        ...(row.displayName === undefined ? {} : { displayName: row.displayName }),
        roleKeys: membership.roleKeys,
        attributes: {},
        invitedBy: options.actorId,
      });
      if (invited.ok) {
        createdUser = createdUser || invited.value.createdUser;
        firstUserId = invited.value.member.userId;
        outcome.memberships.push({
          clientId: membership.clientId,
          action: 'created',
          membershipId: invited.value.member.membershipId,
          roleKeys: membership.roleKeys,
        });
        continue;
      }
      if (invited.reason === 'duplicate') {
        const user =
          firstUserId !== null ? { id: firstUserId } : await options.ports.findUser(row.email);
        const current =
          user === null ? null : await options.ports.findMembership(membership.clientId, user.id);
        firstUserId = user?.id ?? firstUserId;
        outcome.memberships.push({
          clientId: membership.clientId,
          action: 'exists',
          roleKeys: membership.roleKeys,
          ...(current === null ? {} : { membershipId: current.membershipId }),
        });
        continue;
      }
      failures.push(`${membership.clientId}: ${invited.reason}`);
      outcome.memberships.push({
        clientId: membership.clientId,
        action: 'error',
        roleKeys: membership.roleKeys,
        detail: invited.detail,
      });
    }

    outcome.userId = firstUserId;

    if (failures.length > 0) {
      outcome.status = 'error';
      outcome.reason = failures.join('; ');
      outcomes.push(outcome);
      continue;
    }
    const allExisted = outcome.memberships.every((item) => item.action === 'exists');
    outcome.status = allExisted ? 'skipped' : createdUser ? 'created' : 'linked';

    if (
      mailMode === 'none' ||
      firstUserId === null ||
      (outcome.status === 'skipped' && options.resendMail !== true)
    ) {
      outcomes.push(outcome);
      continue;
    }

    await throttle();
    try {
      if (mailMode === 'verification') {
        outcome.mail = (await options.ports.sendVerification(firstUserId))
          ? 'verification'
          : 'skipped';
      } else {
        outcome.mail = await options.ports.sendInvite(firstUserId);
      }
    } catch (error) {
      outcome.mail = 'failed';
      outcome.reason = `mail-send-failed: ${
        error instanceof Error ? error.message : 'unknown error'
      }`;
    }
    outcomes.push(outcome);
  }

  return {
    version: 1,
    generatedAt: now().toISOString(),
    dryRun,
    mailMode,
    clients: [...options.allowedClients],
    totals: totalsOf(outcomes),
    rows: outcomes,
  };
}

export interface ImportRollbackPorts {
  removeMembership(clientId: string, userId: string): Promise<'deleted' | 'not-found'>;
  /**
   * Returns the reasons a user created by the import cannot be deleted safely (password,
   * session, refresh token, MFA factor or a linked identity).
   */
  userRemovalBlockers(userId: string): Promise<string[]>;
  deleteUser(userId: string): Promise<void>;
}

export interface ImportRollbackRowOutcome {
  line: number;
  email: string | null;
  memberships: { clientId: string; action: 'deleted' | 'absent' }[];
  user: 'deleted' | 'kept' | 'absent';
  detail?: string;
}

export interface ImportRollbackSummary {
  version: 1;
  generatedAt: string;
  dryRun: boolean;
  rows: ImportRollbackRowOutcome[];
}

export interface ImportRollbackOptions {
  summary: ImportSummary;
  ports: ImportRollbackPorts;
  dryRun?: boolean;
  /** Keep the central users; only remove the memberships this import created. */
  keepUsers?: boolean;
  now?: () => Date;
}

/**
 * Rolls an import back from its summary: memberships created by the run are removed, and a
 * user created by the run is deleted only when it has no password, session, refresh token,
 * MFA factor or linked identity. Everything else is reported instead of silently kept.
 */
export async function rollbackUserImport(
  options: ImportRollbackOptions,
): Promise<ImportRollbackSummary> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? (() => new Date());
  const outcomes: ImportRollbackRowOutcome[] = [];

  for (const row of [...options.summary.rows].reverse()) {
    const memberships: ImportRollbackRowOutcome['memberships'] = [];
    if (row.userId !== null) {
      for (const membership of row.memberships) {
        if (membership.action !== 'created') {
          continue;
        }
        if (dryRun) {
          memberships.push({ clientId: membership.clientId, action: 'deleted' });
          continue;
        }
        const removed = await options.ports.removeMembership(membership.clientId, row.userId);
        memberships.push({
          clientId: membership.clientId,
          action: removed === 'deleted' ? 'deleted' : 'absent',
        });
      }
    }

    if (row.userId === null || row.status !== 'created' || options.keepUsers === true) {
      outcomes.push({
        line: row.line,
        email: row.email,
        memberships,
        user: row.userId === null ? 'absent' : 'kept',
        ...(row.userId === null
          ? {}
          : {
              detail:
                options.keepUsers === true
                  ? '--keep-users: the central user was left in place'
                  : 'the user existed before the import',
            }),
      });
      continue;
    }

    if (dryRun) {
      outcomes.push({ line: row.line, email: row.email, memberships, user: 'deleted' });
      continue;
    }
    const blockers = await options.ports.userRemovalBlockers(row.userId);
    if (blockers.length > 0) {
      outcomes.push({
        line: row.line,
        email: row.email,
        memberships,
        user: 'kept',
        detail: `manual review required: ${blockers.join(', ')}`,
      });
      continue;
    }
    await options.ports.deleteUser(row.userId);
    outcomes.push({ line: row.line, email: row.email, memberships, user: 'deleted' });
  }

  return {
    version: 1,
    generatedAt: now().toISOString(),
    dryRun,
    rows: outcomes,
  };
}
