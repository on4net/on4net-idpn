import { z } from 'zod';

const publicClientId = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, 'letters, digits, dot, dash and underscore only');

export const listSessionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  userId: z.string().uuid().optional(),
  clientId: publicClientId.optional(),
  loginContext: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'letters, digits, dot, dash and underscore only')
    .optional(),
  status: z.enum(['active', 'revoked', 'expired']).optional(),
});

export type ListSessionsQueryInput = z.infer<typeof listSessionsQuerySchema>;
