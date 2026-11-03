import { z } from 'zod';

const publicClientId = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, 'letters, digits, dot, dash and underscore only');

export const catalogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  clientId: publicClientId.optional(),
  q: z.string().trim().min(1).max(120).optional(),
});

export const createPermissionSchema = z.object({
  key: z.string().trim().min(1).max(160),
  clientId: publicClientId.nullable().default(null),
  description: z.string().trim().min(1).max(200),
});

export const createRoleSchema = z.object({
  key: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(200).default(''),
  clientId: publicClientId.nullable().default(null),
  isDefault: z.boolean().default(false),
  permissions: z.array(z.string().trim().min(1).max(160)).max(200).default([]),
});

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(200).optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });

export const replaceRolePermissionsSchema = z.object({
  permissions: z.array(z.string().trim().min(1).max(160)).max(200),
});

export type CatalogQueryInput = z.infer<typeof catalogQuerySchema>;
export type CreatePermissionBody = z.infer<typeof createPermissionSchema>;
export type CreateRoleBody = z.infer<typeof createRoleSchema>;
export type UpdateRoleBody = z.infer<typeof updateRoleSchema>;
