import { z } from 'zod';

import type { SocialProvider } from '../admin/social-providers/social-provider-types.js';

/**
 * Credential source for the onboarding CLI.
 *
 * Nothing here stores, logs or returns a secret beyond the single `applySocialProvider` call:
 * the CLI reads it, encrypts it with the existing AES-256-GCM secret box, and keeps only a
 * hint (last four characters of the public client id) in its summary.
 */

export interface SocialCredential {
  clientKey: string;
  clientSecret: string;
}

/** Resolves credentials at run time; `null` means "not configured for this app/provider". */
export type SocialCredentialLookup = (
  clientId: string,
  provider: SocialProvider,
) => SocialCredential | null;

const clientKeySchema = z.string().trim().min(1).max(512);
const clientSecretSchema = z.string().min(1).max(2048);

/**
 * Environment variable name for a credential. The public client id is upper-cased and every
 * non-alphanumeric character becomes `_`, so `platform-a` + `google` maps to
 * `IDPN_SOCIAL_PLATFORM_A_GOOGLE_CLIENT_KEY` / `..._CLIENT_SECRET`.
 */
export function socialCredentialEnvRef(
  clientId: string,
  provider: SocialProvider,
  field: 'CLIENT_KEY' | 'CLIENT_SECRET',
): string {
  const app = clientId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `IDPN_SOCIAL_${app}_${provider.toUpperCase()}_${field}`;
}

/** Masks the public client id for output: enough to confirm which key was stored. */
export function maskClientKey(clientKey: string): string {
  const trimmed = clientKey.trim();
  if (trimmed.length <= 4) {
    return '***';
  }
  return `***${trimmed.slice(-4)}`;
}

/** Reads credentials from the process environment (or any plain object in tests). */
export function createEnvCredentialLookup(
  env: Record<string, string | undefined>,
  overrides: Partial<Record<string, { clientKeyRef?: string; clientSecretRef?: string }>> = {},
): SocialCredentialLookup {
  return (clientId, provider) => {
    const override = overrides[provider];
    const keyRef =
      override?.clientKeyRef ?? socialCredentialEnvRef(clientId, provider, 'CLIENT_KEY');
    const secretRef =
      override?.clientSecretRef ?? socialCredentialEnvRef(clientId, provider, 'CLIENT_SECRET');
    const clientKey = env[keyRef]?.trim() ?? '';
    const clientSecret = env[secretRef] ?? '';
    if (clientKey === '' || clientSecret === '') {
      return null;
    }
    const parsed = z
      .object({ clientKey: clientKeySchema, clientSecret: clientSecretSchema })
      .safeParse({ clientKey, clientSecret });
    return parsed.success ? parsed.data : null;
  };
}

/**
 * Secrets file shape (never committed; `*.secrets.json` is ignored by git):
 *
 * ```json
 * { "apps": { "platform-a": { "google": { "clientKey": "...", "clientSecret": "..." } } } }
 * ```
 */
export const secretsFileSchema = z.strictObject({
  apps: z.record(
    z.string().min(1).max(64),
    z.partialRecord(
      z.enum(['google', 'facebook']),
      z.strictObject({
        clientKey: clientKeySchema,
        clientSecret: clientSecretSchema,
      }),
    ),
  ),
});

export type SecretsFile = z.infer<typeof secretsFileSchema>;

export interface SecretsParseResult {
  ok: boolean;
  secrets: SecretsFile | null;
  problems: string[];
}

/** Parses the secrets document; error messages never echo a value. */
export function parseSecretsFile(value: unknown): SecretsParseResult {
  const parsed = secretsFileSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      secrets: null,
      problems: parsed.error.issues.map((issue) => {
        const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
        return `${path}: ${issue.message}`;
      }),
    };
  }
  return { ok: true, secrets: parsed.data, problems: [] };
}

/** File entries win over environment variables so a rotation can be rehearsed locally. */
export function combineCredentialLookups(
  file: SecretsFile | null,
  env: SocialCredentialLookup,
): SocialCredentialLookup {
  return (clientId, provider) => {
    const entry = file?.apps[clientId]?.[provider];
    if (entry !== undefined) {
      return { clientKey: entry.clientKey, clientSecret: entry.clientSecret };
    }
    return env(clientId, provider);
  };
}

/**
 * The onboarding CLI refuses to touch a production deployment without `--confirm`, mirroring
 * the step-up requirement of the Admin API endpoint it replaces.
 */
export function productionConfirmationProblem(
  nodeEnv: string | undefined,
  confirm: boolean,
): string | null {
  if (nodeEnv === 'production' && !confirm) {
    return 'refusing to run with NODE_ENV=production without --confirm';
  }
  return null;
}

/**
 * Base URL used to derive the provider callback. Mirrors the runtime: the Auth Server uses
 * `SOCIAL_CALLBACK_BASE_URL` when it is set and falls back to the issuer/`APP_URL`.
 */
export function resolveCallbackBase(env: {
  SOCIAL_CALLBACK_BASE_URL?: string | undefined;
  APP_URL?: string | undefined;
}): string | null {
  const explicit = env.SOCIAL_CALLBACK_BASE_URL?.trim();
  const fallback = env.APP_URL?.trim();
  const value = explicit !== undefined && explicit !== '' ? explicit : fallback;
  return value === undefined || value === '' ? null : value.replace(/\/+$/, '');
}

/** Google and Facebook require an HTTPS callback outside localhost. */
export function callbackUrlProblem(
  callbackUrl: string,
  nodeEnv: string | undefined,
): string | null {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return `callback URL "${callbackUrl}" is not a valid URL`;
  }
  if (url.protocol === 'https:') {
    return null;
  }
  const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol === 'http:' && localHost && nodeEnv !== 'production') {
    return null;
  }
  return `callback URL "${callbackUrl}" must use https outside local development`;
}
