import { z } from 'zod';

import { idpnThemeSchema } from './theme.js';

/** Direction of a locale; used by both the public config and the MFE contract. */
export const localeDirSchema = z.enum(['rtl', 'ltr']);

/**
 * BCP-47-shaped language tag. The public config is browser input, so a value with markup
 * or whitespace must never reach `lang`/`dir` or a translation request.
 */
export const localeCodeSchema = z
  .string()
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'must be a locale code');

export const localeBundleSchema = z
  .object({
    default: localeCodeSchema,
    supported: z.array(localeCodeSchema).min(1),
    dir: z.record(localeCodeSchema, localeDirSchema),
    version: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const normalized = value.supported.map((locale) => locale.toLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      ctx.addIssue({ code: 'custom', path: ['supported'], message: 'must not contain duplicates' });
    }
    if (!normalized.includes(value.default.toLowerCase())) {
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: 'default must be one of the supported locales',
      });
    }
    for (const locale of value.supported) {
      if (value.dir[locale] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['dir'],
          message: `missing direction for ${locale}`,
        });
      }
    }
    for (const locale of Object.keys(value.dir)) {
      if (!value.supported.includes(locale)) {
        ctx.addIssue({
          code: 'custom',
          path: ['dir'],
          message: `${locale} is not a supported locale`,
        });
      }
    }
  });

export const mfaPolicySchema = z.enum(['optional', 'required_admins', 'required_all']);
export const registrationPolicySchema = z.enum(['invite_only', 'self_service', 'disabled']);
export const loginMethodSchema = z.enum(['password', 'google', 'facebook', 'otp', 'sso']);
export const socialProviderSchema = z.enum(['google', 'facebook']);

export const loginContextSummarySchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    methods: z.array(loginMethodSchema).min(1),
    mfaPolicy: mfaPolicySchema,
  })
  .strict();

export const socialProviderSummarySchema = z
  .object({
    provider: socialProviderSchema,
    label: z.string().min(1),
  })
  .strict();

export const clientFeaturesSchema = z
  .object({
    userManagement: z.boolean(),
    selfServiceRegistration: z.boolean(),
    mfa: z.boolean(),
  })
  .strict();

export const mfeReleaseSchema = z
  .object({
    version: z.string().min(1),
    remoteEntry: z.string().url(),
  })
  .strict();

/**
 * `GET /api/v1/clients/{clientId}/public-config` (docs/api.md 2.7).
 * Strict: an accidentally added secret or internal field fails the contract test.
 */
export const publicClientConfigSchema = z
  .object({
    clientId: z.string().min(1),
    name: z.string().min(1),
    logoUrl: z.string().url().optional(),
    locale: z.string().min(1),
    locales: localeBundleSchema.strict(),
    translationsUrl: z.string().url().optional(),
    theme: idpnThemeSchema,
    registrationPolicy: registrationPolicySchema,
    mfaPolicy: mfaPolicySchema,
    loginContexts: z.array(loginContextSummarySchema),
    defaultLoginContext: z.string().min(1).optional(),
    socialProviders: z.array(socialProviderSummarySchema),
    features: clientFeaturesSchema,
    mfe: mfeReleaseSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.locale !== value.locales.default) {
      ctx.addIssue({
        code: 'custom',
        path: ['locale'],
        message: 'locale must equal locales.default',
      });
    }
    if (value.locales.dir[value.locale] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['locales', 'dir'],
        message: 'the active locale needs a direction',
      });
    }
  });

export type PublicClientConfig = z.infer<typeof publicClientConfigSchema>;
export type LoginContextSummary = z.infer<typeof loginContextSummarySchema>;
export type LocaleBundle = z.infer<typeof localeBundleSchema>;
