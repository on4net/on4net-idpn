import { z } from 'zod';

const isoDateTime = z
  .string()
  .trim()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const filterFields = {
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  action: z.string().trim().min(1).max(128).optional(),
  actorId: z.string().uuid().optional(),
  clientId: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'letters, digits, dot, dash and underscore only')
    .optional(),
  targetType: z.string().trim().min(1).max(64).optional(),
  result: z.enum(['success', 'failure']).optional(),
} as const;

const chronological = <T extends { from?: Date; to?: Date }>(value: T): boolean =>
  value.from === undefined || value.to === undefined || value.from.getTime() <= value.to.getTime();

export const listAuditEventsQuerySchema = z
  .object({
    ...filterFields,
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    /**
     * Opaque keyset cursor (`occurred_at|id`, base64url). When present it wins over `page`,
     * so an auditor paging through a busy log never skips or repeats a row because new events
     * shifted the offset.
     */
    cursor: z.string().trim().min(1).max(200).optional(),
  })
  .refine(chronological, { message: 'from must not be after to', path: ['from'] });

export const exportAuditEventsQuerySchema = z
  .object({
    ...filterFields,
    format: z.enum(['csv', 'ndjson']).default('csv'),
  })
  .refine(chronological, { message: 'from must not be after to', path: ['from'] });

export type ListAuditEventsQuery = z.infer<typeof listAuditEventsQuerySchema>;
export type ExportAuditEventsQuery = z.infer<typeof exportAuditEventsQuerySchema>;
