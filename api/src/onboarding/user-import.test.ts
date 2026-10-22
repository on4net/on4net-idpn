import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { AdminMember, InviteMemberInput } from '../admin/members/member-types.js';
import {
  parseUserCsv,
  parseUserJson,
  rollbackUserImport,
  runUserImport,
  type ImportRollbackPorts,
  type ImportSummary,
  type UserImportPorts,
} from './user-import.js';

const options = { allowedClients: ['platform-a', 'platform-b'], defaultClient: 'platform-a' };

const member = (clientId: string, userId: string): AdminMember => ({
  membershipId: `membership-${clientId}-${userId}`,
  userId,
  email: 'user@example.com',
  username: 'user',
  displayName: 'User',
  userStatus: 'pending',
  status: 'invited',
  attributes: {},
  loginContextKey: null,
  roleKeys: [],
  invitedAt: null,
  joinedAt: null,
  lastAccessAt: null,
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
});

interface FakeState {
  users: Map<string, { id: string; hasPassword: boolean }>;
  memberships: Set<string>;
  invites: InviteMemberInput[];
  mails: { kind: 'invite' | 'verification'; userId: string }[];
}

function createFakePorts(
  state: FakeState,
  options2: { failClient?: string } = {},
): UserImportPorts {
  return {
    async findUser(email) {
      return state.users.get(email) ?? null;
    },
    async findMembership(clientId, userId) {
      return state.memberships.has(`${clientId}:${userId}`)
        ? { membershipId: `membership-${clientId}-${userId}`, status: 'invited' }
        : null;
    },
    async invite(clientId, input) {
      state.invites.push(input);
      if (options2.failClient === clientId) {
        return { ok: false, reason: 'unknown-role', detail: 'unknown role(s): x:y' };
      }
      const existing = state.users.get(input.email);
      const userId = existing?.id ?? `user-${state.users.size + 1}`;
      if (!state.memberships.has(`${clientId}:${userId}`)) {
        state.memberships.add(`${clientId}:${userId}`);
      } else {
        return { ok: false, reason: 'duplicate', detail: 'already a member' };
      }
      state.users.set(input.email, { id: userId, hasPassword: existing?.hasPassword ?? false });
      return {
        ok: true,
        value: { member: member(clientId, userId), createdUser: existing === undefined },
      };
    },
    async sendInvite(userId) {
      state.mails.push({ kind: 'invite', userId });
      const hasPassword = [...state.users.values()].find((user) => user.id === userId)?.hasPassword;
      return hasPassword === true ? 'notification' : 'invitation';
    },
    async sendVerification(userId) {
      state.mails.push({ kind: 'verification', userId });
      return true;
    },
  };
}

const emptyState = (): FakeState => ({
  users: new Map(),
  memberships: new Set(),
  invites: [],
  mails: [],
});

describe('CSV parsing', () => {
  it('reads quoted fields, role lists and explicit memberships with line numbers', () => {
    const csv = [
      'email,displayName,externalId,locale,roleKeys,memberships',
      'User@Example.com,"Doe, Jane",legacy-1,en-US,platform-a:member;platform-a:viewer,',
      'second@example.com,Second,legacy-2,fa-IR,,',
    ].join('\r\n');

    const parsed = parseUserCsv(csv, options);
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual({
      line: 2,
      email: 'user@example.com',
      displayName: 'Doe, Jane',
      externalId: 'legacy-1',
      locale: 'en-US',
      memberships: [
        { clientId: 'platform-a', roleKeys: ['platform-a:member', 'platform-a:viewer'] },
      ],
    });
    expect(parsed.rows[1]?.memberships).toEqual([{ clientId: 'platform-a', roleKeys: [] }]);
  });

  it('reads an explicit memberships JSON column for several apps', () => {
    const csv = [
      'email,memberships',
      'multi@example.com,"[{""clientId"":""platform-a"",""roleKeys"":[""platform-a:member""]},{""clientId"":""platform-b"",""roleKeys"":[]}]"',
    ].join('\n');
    const parsed = parseUserCsv(csv, options);
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows[0]?.memberships).toEqual([
      { clientId: 'platform-a', roleKeys: ['platform-a:member'] },
      { clientId: 'platform-b', roleKeys: [] },
    ]);
  });

  it('reports bad rows, unknown columns, duplicates and foreign clients', () => {
    const csv = [
      'email,externalId,nickname',
      'not-an-email,,x',
      'dup@example.com,legacy-1,',
      'dup@example.com,legacy-2,',
      'other@example.com,legacy-1,',
    ].join('\n');
    const parsed = parseUserCsv(csv, options);
    expect(parsed.rows).toHaveLength(1);
    const messages = parsed.problems.map((problem) => `${problem.line}: ${problem.message}`);
    expect(messages).toContain('1: unknown column "nickname"');
    expect(messages.some((message) => message.startsWith('2: email is missing'))).toBe(true);
    expect(messages.some((message) => message.includes('duplicate-row: email'))).toBe(true);
    expect(messages.some((message) => message.includes('duplicate-row: externalId'))).toBe(true);

    const foreign = parseUserCsv(
      'email,memberships\nx@example.com,"[{""clientId"":""platform-z"",""roleKeys"":[]}]"',
      options,
    );
    expect(foreign.problems[0]?.message).toContain('not allowed');

    const wrongRole = parseUserCsv('email,roleKeys\nx@example.com,platform-b:member', {
      allowedClients: ['platform-a'],
      defaultClient: 'platform-a',
    });
    expect(wrongRole.problems[0]?.message).toContain('must start with "platform-a"');
  });

  it('reports a missing header row', () => {
    expect(parseUserCsv('', options).problems[0]?.message).toBe('header row is missing');
  });
});

describe('JSON parsing', () => {
  it('accepts camel and snake case fields and a memberships map', () => {
    const parsed = parseUserJson(
      {
        users: [
          { email: 'a@example.com', display_name: 'A', external_id: 'x-1' },
          {
            email: 'b@example.com',
            memberships: { 'platform-b': ['platform-b:member'] },
          },
        ],
      },
      options,
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows[0]?.displayName).toBe('A');
    expect(parsed.rows[0]?.externalId).toBe('x-1');
    expect(parsed.rows[1]?.memberships).toEqual([
      { clientId: 'platform-b', roleKeys: ['platform-b:member'] },
    ]);
  });

  it('rejects a document that is not a user list', () => {
    expect(parseUserJson({ rows: [] }, options).problems[0]?.message).toBe(
      'expected an array of users',
    );
  });
});

describe('committed examples', () => {
  it('keeps examples/onboarding/users.csv importable', async () => {
    const content = await readFile(
      new URL('../../../examples/onboarding/users.csv', import.meta.url),
      'utf8',
    );
    const parsed = parseUserCsv(content, options);
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows.map((row) => row.email)).toEqual([
      'ali.rezaei@example.com',
      'sara.ahmadi@example.com',
      'reza.karimi@example.com',
    ]);
    expect(parsed.rows[2]?.memberships).toEqual([
      { clientId: 'platform-a', roleKeys: ['platform-a:member'] },
      { clientId: 'platform-b', roleKeys: ['platform-b:member'] },
    ]);
  });

  it('keeps examples/onboarding/users.json importable', async () => {
    const content = await readFile(
      new URL('../../../examples/onboarding/users.json', import.meta.url),
      'utf8',
    );
    const parsed = parseUserJson(JSON.parse(content) as unknown, options);
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows[1]?.memberships).toEqual([
      { clientId: 'platform-a', roleKeys: ['platform-a:editor'] },
      { clientId: 'platform-b', roleKeys: ['platform-b:member'] },
    ]);
  });
});

describe('import run', () => {
  it('creates, links, skips and reports errors per row', async () => {
    const parsed = parseUserCsv(
      [
        'email,displayName,roleKeys',
        'new@example.com,New,platform-a:member',
        'member@example.com,Existing,platform-a:member',
        'invalid,Missing,',
      ].join('\n'),
      options,
    );
    expect(parsed.problems).toHaveLength(1);

    const state = emptyState();
    state.users.set('member@example.com', { id: 'existing-user', hasPassword: true });
    state.memberships.add('platform-a:existing-user');

    const ports = createFakePorts(state);
    const summary = await runUserImport({
      parsed,
      allowedClients: options.allowedClients,
      actorId: '00000000-0000-0000-0000-000000000001',
      ports,
      now: () => new Date('2026-10-19T10:00:00.000Z'),
    });

    expect(summary.totals).toEqual({
      rows: 3,
      created: 1,
      linked: 0,
      skipped: 1,
      error: 1,
      mailSent: 1,
      mailFailed: 0,
    });
    expect(summary.rows[0]?.status).toBe('error');
    expect(summary.rows[1]?.status).toBe('created');
    expect(summary.rows[1]?.mail).toBe('invitation');
    expect(summary.rows[2]?.status).toBe('skipped');
    expect(summary.rows[2]?.mail).toBe('not-sent');
    // A create never carries credentials into the membership repository.
    for (const invite of state.invites) {
      expect(Object.keys(invite)).not.toContain('password');
      expect(Object.keys(invite)).not.toContain('passwordHash');
    }
  });

  it('resends mail for already imported rows only when asked', async () => {
    const parsed = parseUserJson([{ email: 'member@example.com' }], options);
    const state = emptyState();
    state.users.set('member@example.com', { id: 'existing-user', hasPassword: false });
    state.memberships.add('platform-a:existing-user');

    const withoutResend = await runUserImport({
      parsed,
      allowedClients: options.allowedClients,
      actorId: 'actor',
      ports: createFakePorts(state),
    });
    expect(withoutResend.totals.mailSent).toBe(0);

    state.mails.length = 0;
    const withResend = await runUserImport({
      parsed,
      allowedClients: options.allowedClients,
      actorId: 'actor',
      resendMail: true,
      ports: createFakePorts(state),
    });
    expect(withResend.rows[0]?.status).toBe('skipped');
    expect(withResend.rows[0]?.mail).toBe('invitation');
  });

  it('throttles mail sends to the configured rate', async () => {
    const parsed = parseUserJson(
      [{ email: 'a@example.com' }, { email: 'b@example.com' }, { email: 'c@example.com' }],
      options,
    );
    const state = emptyState();
    let clock = 0;
    const sleeps: number[] = [];
    await runUserImport({
      parsed,
      allowedClients: options.allowedClients,
      actorId: 'actor',
      mailIntervalMs: 1000,
      now: () => new Date(clock),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
      ports: createFakePorts(state),
    });
    expect(sleeps).toEqual([1000, 1000]);
    expect(state.mails).toHaveLength(3);
  });

  it('reports a member failure as an error row without sending mail', async () => {
    const parsed = parseUserJson([{ email: 'a@example.com' }], options);
    const state = emptyState();
    const summary = await runUserImport({
      parsed,
      allowedClients: options.allowedClients,
      actorId: 'actor',
      ports: createFakePorts(state, { failClient: 'platform-a' }),
    });
    expect(summary.rows[0]?.status).toBe('error');
    expect(summary.rows[0]?.reason).toContain('unknown-role');
    expect(summary.totals.mailSent).toBe(0);
  });

  it('does not write or mail in dry-run mode', async () => {
    const parsed = parseUserJson([{ email: 'new@example.com' }], options);
    const state = emptyState();
    const summary = await runUserImport({
      parsed,
      allowedClients: options.allowedClients,
      actorId: '',
      dryRun: true,
      ports: createFakePorts(state),
    });
    expect(summary.dryRun).toBe(true);
    expect(summary.rows[0]?.status).toBe('created');
    expect(summary.rows[0]?.mail).toBe('not-sent');
    expect(state.invites).toEqual([]);
    expect(state.mails).toEqual([]);
  });
});

describe('import rollback', () => {
  const summary: ImportSummary = {
    version: 1,
    generatedAt: '2026-10-19T10:00:00.000Z',
    dryRun: false,
    mailMode: 'invite',
    clients: ['platform-a'],
    totals: {
      rows: 2,
      created: 1,
      linked: 1,
      skipped: 0,
      error: 0,
      mailSent: 2,
      mailFailed: 0,
    },
    rows: [
      {
        line: 1,
        email: 'created@example.com',
        externalId: null,
        userId: 'created-user',
        status: 'created',
        memberships: [
          {
            clientId: 'platform-a',
            action: 'created',
            membershipId: 'membership-platform-a-created-user',
            roleKeys: [],
          },
        ],
        mail: 'invitation',
      },
      {
        line: 2,
        email: 'existing@example.com',
        externalId: null,
        userId: 'existing-user',
        status: 'linked',
        memberships: [
          {
            clientId: 'platform-a',
            action: 'created',
            membershipId: 'membership-platform-a-existing-user',
            roleKeys: [],
          },
        ],
        mail: 'notification',
      },
    ],
  };

  it('removes imported memberships and deletes only safe users', async () => {
    const removed: string[] = [];
    const deleted: string[] = [];
    const ports: ImportRollbackPorts = {
      async removeMembership(clientId, userId) {
        removed.push(`${clientId}:${userId}`);
        return 'deleted';
      },
      async userRemovalBlockers(userId) {
        return userId === 'existing-user' ? ['local-password'] : [];
      },
      async deleteUser(userId) {
        deleted.push(userId);
      },
    };

    const result = await rollbackUserImport({ summary, ports });
    expect(removed).toEqual(['platform-a:existing-user', 'platform-a:created-user']);
    expect(deleted).toEqual(['created-user']);
    // Rows are reverted in reverse order so a later membership is removed before its user.
    expect(result.rows.map((row) => row.user)).toEqual(['kept', 'deleted']);
    expect(result.rows[0]?.detail).toContain('the user existed before the import');
  });

  it('keeps a user that gained credentials after the import', async () => {
    const ports: ImportRollbackPorts = {
      async removeMembership() {
        return 'deleted';
      },
      async userRemovalBlockers() {
        return ['local-password', 'active-sessions'];
      },
      async deleteUser() {
        throw new Error('must not delete a user with credentials');
      },
    };
    const result = await rollbackUserImport({
      summary: { ...summary, rows: [summary.rows[0]!] },
      ports,
    });
    expect(result.rows[0]?.user).toBe('kept');
    expect(result.rows[0]?.detail).toContain('local-password, active-sessions');
  });

  it('honours --keep-users and dry-run', async () => {
    const ports: ImportRollbackPorts = {
      async removeMembership() {
        return 'deleted';
      },
      async userRemovalBlockers() {
        return [];
      },
      async deleteUser() {
        throw new Error('must not delete in dry-run or with --keep-users');
      },
    };
    const dryRun = await rollbackUserImport({ summary, ports, dryRun: true });
    expect(dryRun.rows[1]?.user).toBe('deleted');

    const kept = await rollbackUserImport({ summary, ports, keepUsers: true });
    expect(kept.rows.map((row) => row.user)).toEqual(['kept', 'kept']);
  });
});
