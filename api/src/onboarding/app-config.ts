import { z } from 'zod';

import {
  DEFAULT_SOCIAL_SCOPES,
  SOCIAL_PROVIDERS,
} from '../admin/social-providers/social-provider-types.js';

/**
 * Declarative per-app onboarding document (`docs/app-onboarding.md`).
 *
 * The document is safe to commit: it holds no credential. Credentials are referenced by the
 * *name* of an environment variable or by an entry in a non-committed secrets file, and the
 * CLI resolves them at run time (`social-credentials.ts`).
 */

/** Public client id shape used by `docs/api.md` 3.3 and the Admin API. */
export const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Catalog keys are validated again by `rbac-validation.ts`; this only checks the shape. */
const catalogKey = (max: number) => z.string().trim().min(3).max(max);

const scopeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/, 'must be a scope token');

const domainSchema = z
  .string()
  .trim()
  .min(3)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
    'must be a domain name such as example.com',
  )
  .transform((value) => value.toLowerCase());

/** Name of an environment variable that holds a credential; never the credential itself. */
const envRefSchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'must be an upper-case environment variable name');

export const socialProviderConfigSchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    scopes: z
      .array(scopeSchema)
      .min(1)
      .max(40)
      .default([...DEFAULT_SOCIAL_SCOPES]),
    allowedEmailDomains: z.array(domainSchema).max(50).default([]),
    /** Env var holding the provider client id; defaults to the derived `IDPN_SOCIAL_*` name. */
    clientKeyRef: envRefSchema.optional(),
    /** Env var holding the provider client secret; defaults to the derived `IDPN_SOCIAL_*` name. */
    clientSecretRef: envRefSchema.optional(),
  })
  .strict();

export const permissionDefinitionSchema = z
  .strictObject({
    key: catalogKey(160),
    description: z.string().trim().min(1).max(200),
  })
  .strict();

export const roleDefinitionSchema = z
  .strictObject({
    key: catalogKey(160),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(300),
    /** Permission keys linked to the role (app-owned, or the delegated-admin allowlist). */
    permissions: z.array(catalogKey(160)).default([]),
  })
  .strict();

export const appOnboardingConfigSchema = z
  .strictObject({
    clientId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(CLIENT_ID_PATTERN, 'must be a public client id'),
    /** Human label for the summary; the client row itself is created by the Admin API. */
    name: z.string().trim().min(1).max(120).optional(),
    socialProviders: z
      .partialRecord(z.enum(SOCIAL_PROVIDERS), socialProviderConfigSchema)
      .default({}),
    permissions: z.array(permissionDefinitionSchema).default([]),
    roles: z.array(roleDefinitionSchema).min(1).max(100),
    /** Role every new member receives; must be declared in `roles`. */
    defaultRole: catalogKey(160),
    /** Delegated user-administration role; must be declared in `roles`. */
    userAdminRole: catalogKey(160),
  })
  .strict();

export type AppOnboardingConfig = z.infer<typeof appOnboardingConfigSchema>;
export type SocialProviderConfig = z.infer<typeof socialProviderConfigSchema>;
export type RoleDefinition = z.infer<typeof roleDefinitionSchema>;

export interface ConfigParseResult {
  ok: boolean;
  config: AppOnboardingConfig | null;
  problems: string[];
}

const issueDetail = (error: z.ZodError): string[] =>
  error.issues.map((issue) => {
    const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
    return `${path}: ${issue.message}`;
  });

/** Parses an untrusted JSON value; returns every problem instead of only the first. */
export function parseAppOnboardingConfig(value: unknown): ConfigParseResult {
  const parsed = appOnboardingConfigSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, config: null, problems: issueDetail(parsed.error) };
  }
  return { ok: true, config: parsed.data, problems: [] };
}
