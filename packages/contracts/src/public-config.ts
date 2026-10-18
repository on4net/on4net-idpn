import { z } from 'zod';

/** Direction of a locale; used by both the public config and the MFE contract. */
export const localeDirSchema = z.enum(['rtl', 'ltr']);

export const localeBundleSchema = z.object({
  default: z.string().min(1),
  supported: z.array(z.string().min(1)).min(1),
  dir: z.record(z.string(), localeDirSchema),
  version: z.string().optional(),
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
    theme: z.record(z.string(), z.string()),
    registrationPolicy: registrationPolicySchema,
    mfaPolicy: mfaPolicySchema,
    loginContexts: z.array(loginContextSummarySchema),
    defaultLoginContext: z.string().min(1).optional(),
    socialProviders: z.array(socialProviderSummarySchema),
    features: clientFeaturesSchema,
    mfe: mfeReleaseSchema,
  })
  .strict();

export type PublicClientConfig = z.infer<typeof publicClientConfigSchema>;
export type LoginContextSummary = z.infer<typeof loginContextSummarySchema>;
export type LocaleBundle = z.infer<typeof localeBundleSchema>;
