import { describe, expect, it } from 'vitest';

import { exportAuditEventsQuerySchema, listAuditEventsQuerySchema } from './audit-schemas.js';
import {
  MAX_AUDIT_EXPORT_ROWS,
  csvCell,
  formatAuditEventsCsv,
  formatAuditEventsNdjson,
} from './routes.js';
import type { AdminAuditEvent } from './audit-types.js';

const event = (overrides: Partial<AdminAuditEvent> = {}): AdminAuditEvent => ({
  id: 'event-1',
  occurredAt: '2026-10-19T08:00:00.000Z',
  actorType: 'admin',
  actorId: 'user-1',
  action: 'user.update',
  targetType: 'user',
  targetId: 'user-2',
  clientId: 'admin-panel',
  ip: '127.0.0.1',
  userAgent: 'vitest',
  result: 'success',
  metadata: { fields: ['email'] },
  ...overrides,
});

describe('audit query schemas', () => {
  it('applies pagination defaults and parses dates', () => {
    const parsed = listAuditEventsQuerySchema.parse({
      from: '2026-10-01T00:00:00Z',
      result: 'failure',
    });
    expect(parsed).toMatchObject({ page: 1, limit: 25, result: 'failure' });
    expect(parsed.from?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('rejects a reversed time range, oversized limits and unknown formats', () => {
    expect(() =>
      listAuditEventsQuerySchema.parse({
        from: '2026-10-03T00:00:00Z',
        to: '2026-10-01T00:00:00Z',
      }),
    ).toThrow(/from must not be after to/);
    expect(() => listAuditEventsQuerySchema.parse({ limit: '101' })).toThrow();
    expect(() => listAuditEventsQuerySchema.parse({ actorId: 'nope' })).toThrow();
    expect(() => exportAuditEventsQuerySchema.parse({ format: 'xml' })).toThrow();
  });

  it('defaults the export format to CSV', () => {
    expect(exportAuditEventsQuerySchema.parse({}).format).toBe('csv');
  });
});

describe('audit export formatting', () => {
  it('caps an export at the documented 10000 rows', () => {
    expect(MAX_AUDIT_EXPORT_ROWS).toBe(10_000);
  });

  it('neutralises spreadsheet formula injection', () => {
    expect(csvCell('=cmd|calc')).toBe("'=cmd|calc");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@sum')).toBe("'@sum");
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
  });

  it('writes a header and one escaped line per event', () => {
    const csv = formatAuditEventsCsv([
      event({ action: '=HYPERLINK("http://evil")', metadata: { note: 'a,"b"' } }),
    ]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.startsWith('id,occurredAt,actorType')).toBe(true);
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(lines[1]?.endsWith(csvCell(JSON.stringify({ note: 'a,"b"' })))).toBe(true);
  });

  it('writes NDJSON without a trailing newline', () => {
    const ndjson = formatAuditEventsNdjson([event(), event({ id: 'event-2' })]);
    const lines = ndjson.split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ id: 'event-1' });
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ id: 'event-2' });
  });
});
