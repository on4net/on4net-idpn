import { z } from 'zod';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/password-policy.js';
import { USER_SORTS } from './admin-types.js';

const locale = z
  .string()
  .regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/, 'must be a BCP 47 language tag')
  .max(16);

export const userStatusSchema = z.enum(['active', 'pending', 'locked', 'disabled']);

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().min(1).max(120).optional(),
  status: userStatusSchema.optional(),
  sort: z.enum(USER_SORTS).default('createdAt:desc'),
});

export const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'letters, digits, dot, dash and underscore only'),
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().min(1).max(120),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{6,32}$/, 'must be a phone number')
    .nullable()
    .optional(),
  locale: locale.default('fa-IR'),
  status: userStatusSchema.default('active'),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH).optional(),
});

export const updateUserSchema = z
  .object({
    email: z.string().trim().email().max(320).optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{6,32}$/, 'must be a phone number')
      .nullable()
      .optional(),
    locale: locale.optional(),
    avatarUrl: z.string().trim().url().max(2048).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });

export const resetPasswordSchema = z.object({
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH).optional(),
});

export type CreateUserBody = z.infer<typeof createUserSchema>;
export type UpdateUserBody = z.infer<typeof updateUserSchema>;
export type ListUsersQueryInput = z.infer<typeof listUsersQuerySchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;
