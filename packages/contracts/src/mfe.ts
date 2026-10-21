import { z } from 'zod';

import {
  localeBundleSchema,
  localeDirSchema,
  loginMethodSchema,
  socialProviderSchema,
} from './public-config.js';
import { idpnThemeSchema } from './theme.js';

/**
 * Version of the MFE config/event contract. Bump it for every breaking change and
 * keep the previous version in this file until all hosts have migrated.
 *
 * v2: `theme` is a closed `IdpnTheme` object instead of `Record<string, string>`
 * (docs/mfe-sdk.md 8). A host that still sends `{ brand: '#0057b8' }` is now told so by
 * the version mismatch instead of silently rendering unthemed.
 */
export const MFE_SCHEMA_VERSION = 2;

export const publicUserSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    email: z.string().email().optional(),
    avatarUrl: z.string().url().optional(),
  })
  .strict();

export const mfeThemeSchema = idpnThemeSchema;

export const mfeConfigSchema = z
  .object({
    clientId: z.string().min(1),
    mode: z.enum(['bff', 'spa']),
    apiBaseUrl: z.string().min(1),
    loginUrl: z.string().url().optional(),
    locale: z.string().min(1).optional(),
    locales: localeBundleSchema.optional(),
    loginContext: z.string().min(1).optional(),
    theme: mfeThemeSchema.optional(),
    module: z.enum(['account', 'user-management']),
    basename: z.string().optional(),
    features: z
      .object({
        selfServiceRegistration: z.boolean().optional(),
        userManagement: z.boolean().optional(),
        mfa: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const mfeEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('auth:login'),
      user: publicUserSchema,
      loginContext: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('auth:logout'),
      reason: z.enum(['local', 'global', 'expired']),
    })
    .strict(),
  z.object({ type: z.literal('auth:error'), code: z.string().min(1) }).strict(),
  z.object({ type: z.literal('profile:updated'), user: publicUserSchema }).strict(),
  z
    .object({
      type: z.literal('locale:changed'),
      locale: z.string().min(1),
      dir: localeDirSchema,
    })
    .strict(),
  z.object({ type: z.literal('context:changed'), loginContext: z.string().min(1) }).strict(),
  z.object({ type: z.literal('navigation:request'), to: z.string().min(1) }).strict(),
]);

export const mfeEventTypeSchema = z.enum([
  'auth:login',
  'auth:logout',
  'auth:error',
  'profile:updated',
  'locale:changed',
  'context:changed',
  'navigation:request',
]);

export type MfeConfig = z.infer<typeof mfeConfigSchema>;
export type MfeEvent = z.infer<typeof mfeEventSchema>;
export type MfeEventType = z.infer<typeof mfeEventTypeSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;

/** Login methods and social providers a host may rely on. */
export const MFE_LOGIN_METHODS = loginMethodSchema.options;
export const MFE_SOCIAL_PROVIDERS = socialProviderSchema.options;
