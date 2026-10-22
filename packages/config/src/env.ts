import { z } from 'zod';

/**
 * Raw environment source. `process.env` on the server, `import.meta.env` in the
 * browser build, or any plain object in tests.
 */
export type EnvSource = Record<string, string | undefined>;

export interface EnvIssue {
  key: string;
  message: string;
}

/** Thrown when the environment does not satisfy the schema. Never includes values. */
export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
  readonly issues: EnvIssue[];

  constructor(issues: EnvIssue[]) {
    super(
      [
        'Invalid environment configuration:',
        ...issues.map((issue) => `  - ${issue.key}: ${issue.message}`),
        'Fix the values in your .env file. See .env.example and docs/setup.md.',
      ].join('\n'),
    );
    this.issues = issues;
  }
}

const emptyToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);

const requiredUrl = () => z.preprocess(emptyToUndefined, z.string().url());

const optionalUrl = () => z.preprocess(emptyToUndefined, z.string().url().optional());

const origin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.pathname === '/' && url.search === '' && url.hash === '';
  }, 'must be an origin such as https://app.example.com, without a path');

/** AES-256-GCM key for per-client social secrets: canonical base64 of exactly 32 bytes. */
const isSecretKey = (value: string): boolean => {
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === value;
};

const csv = (item: z.ZodType<string, string>) =>
  z
    .preprocess(emptyToUndefined, z.string().optional())
    .transform((value) => {
      if (value === undefined) {
        return [];
      }
      return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    })
    .pipe(z.array(item));

/**
 * Explicit boolean parsing: `z.coerce.boolean()` treats the string `"false"` as true, which
 * would silently enable an operational switch (for example the metrics endpoint).
 */
const booleanFlag = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === '') {
      return defaultValue;
    }
    if (value === true || value === 'true' || value === '1') {
      return true;
    }
    if (value === false || value === 'false' || value === '0') {
      return false;
    }
    return value;
  }, z.boolean());

/** Variables required by the API/Auth Server process, as documented in docs/architecture.md §5. */
const serverEnvBase = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(6000),
  APP_URL: requiredUrl(),
  ADMIN_URL: optionalUrl(),
  /** Public client id of the admin panel; the only client allowed to hold the `idp.admin` scope. */
  ADMIN_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().min(1).max(64).default('admin-panel')),
  DATABASE_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .url()
      .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgresql:// URL'),
  ),
  REDIS_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .url()
      .refine((value) => /^rediss?:\/\//.test(value), 'must be a redis:// or rediss:// URL'),
  ),
  SESSION_SECRET: z.preprocess(
    emptyToUndefined,
    z.string().min(32, 'must be at least 32 characters long'),
  ),
  /** Sliding idle timeout of an IdP session (seconds). */
  SESSION_IDLE_TTL_SECONDS: z.coerce.number().int().min(60).default(1800),
  /** Absolute lifetime of an IdP session (seconds). */
  SESSION_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().min(300).default(28_800),
  /**
   * Maximum concurrent IdP sessions per user. Newest login wins: older sessions beyond the
   * limit are revoked (`0` disables the limit).
   */
  SESSION_MAX_CONCURRENT: z.coerce.number().int().min(0).max(100).default(5),
  /** Optional server-side pepper for Argon2id; supply from KMS/Vault in production. */
  PASSWORD_PEPPER: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  /**
   * Server-side pepper for client-secret hashes (HMAC-SHA-256). Supply it from KMS/Vault: it
   * must never be stored next to the digests and it is required in production
   * (docs/client-secret-hashing.md). At least 32 characters.
   */
  CLIENT_SECRET_PEPPER: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  /**
   * Public identifier stored with every client-secret hash. Rotate the pepper by setting a
   * new id here and listing the previous pepper in `CLIENT_SECRET_PREVIOUS_PEPPERS`.
   */
  CLIENT_SECRET_PEPPER_ID: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,16}$/, 'must be 1-16 letters, digits, dash or underscore')
      .default('k1'),
  ),
  /**
   * Superseded client-secret peppers accepted for verification only, as a comma separated
   * list of `id:pepper` pairs (each pepper at least 32 characters).
   */
  CLIENT_SECRET_PREVIOUS_PEPPERS: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).max(1_048_576).default(65_536),
  ARGON2_TIME_COST: z.coerce.number().int().min(1).max(10).default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(8).default(1),
  SIGNING_KEY_REF: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /**
   * Days between automatic signing-key rotations. `0` disables the scheduler; rotation then
   * happens through `POST /api/v1/keys/rotate` only.
   */
  KEY_ROTATION_INTERVAL_DAYS: z.coerce.number().int().min(0).max(3650).default(90),
  /**
   * How long a retired signing key stays in JWKS. Must cover the longest access-token
   * lifetime (max 3600 s) so tokens issued before a rotation stay verifiable until expiry.
   */
  KEY_RETIRED_RETENTION_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
  /**
   * In-process cache TTL for the signing-key store and the published JWKS (seconds). The
   * JWKS is served with `Cache-Control: max-age=300`; keeping the cache at or below that
   * keeps an out-of-process rotation visible to clients within the header's own window.
   * `0` disables caching (useful for capacity comparisons).
   */
  KEY_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(300).default(30),
  MFE_PUBLIC_URL: optionalUrl(),
  /**
   * Additional browser origins allowed to complete a WebAuthn ceremony. `APP_URL` is always
   * accepted; entries must be origins (no path) and belong to the RP ID derived from
   * `APP_URL` (`docs/security.md` 3.3).
   */
  WEBAUTHN_ALLOWED_ORIGINS: csv(origin).default([]),
  /**
   * Public origin of the Hosted Auth UI. Defaults to `APP_URL` (single-origin deployment);
   * set it when the UI is served from a different host or port than the API.
   */
  HOSTED_UI_URL: optionalUrl(),
  /** Version of the published MFE bundle (used for the remoteEntry URL). */
  MFE_VERSION: z.preprocess(emptyToUndefined, z.string().min(1).default('0.1.0')),
  MFE_ALLOWED_ORIGINS: csv(origin).default([]),
  SOCIAL_CALLBACK_BASE_URL: optionalUrl(),
  /**
   * Key-encryption key for `ClientSocialProvider.clientSecretEncrypted` (AES-256-GCM).
   * Base64 of exactly 32 bytes; supply it from KMS/Vault in production. `loadSocialSecretKey`
   * requires it there so the API fails closed instead of storing secrets unencrypted.
   */
  SOCIAL_SECRET_KEY: z.preprocess(
    emptyToUndefined,
    z.string().refine(isSecretKey, 'must be the base64 encoding of exactly 32 bytes').optional(),
  ),
  /**
   * Optional dedicated key-encryption key for TOTP secrets. Falls back to
   * `SOCIAL_SECRET_KEY`; base64 of exactly 32 bytes.
   */
  MFA_SECRET_KEY: z.preprocess(
    emptyToUndefined,
    z.string().refine(isSecretKey, 'must be the base64 encoding of exactly 32 bytes').optional(),
  ),
  SMTP_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .url()
      .refine((value) => /^smtps?:\/\//.test(value), 'must be an smtp:// or smtps:// URL')
      .optional(),
  ),
  /** Envelope sender for transactional mail (invite, verification, password reset). */
  MAIL_FROM: z.preprocess(emptyToUndefined, z.string().email().default('no-reply@on4net.dev')),
  TRUSTED_PROXY_CIDRS: csv(z.string().min(1)).default([]),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /**
   * Enables the internal Prometheus endpoint (`GET /metrics`, docs/monitoring.md). Keep it
   * disabled unless the instance is reachable only from the metrics network.
   */
  METRICS_ENABLED: booleanFlag(false),
  /**
   * Optional bearer token required by `/metrics`. Supply it from KMS/Vault in production;
   * an empty value relies on network isolation instead.
   */
  METRICS_TOKEN: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  /**
   * JSON status file written by `scripts/ops/backup.ts`; the API exposes its timestamp as
   * `idpn_backup_last_success_timestamp_seconds` so the backup-freshness alert can fire.
   */
  BACKUP_STATUS_FILE: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
});

/**
 * Validated server configuration. The extra refinement fails closed: production must never
 * store client secrets under the public development pepper, nor sign tokens with a key file
 * that belongs to a single replica. The check reports with every other configuration error at
 * startup.
 */
export const serverEnvSchema = serverEnvBase.superRefine((value, ctx) => {
  if (value.NODE_ENV === 'production' && value.CLIENT_SECRET_PEPPER === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['CLIENT_SECRET_PEPPER'],
      message: 'is required in production (supply it from KMS/Vault)',
    });
  }
  if (value.NODE_ENV === 'production' && value.SIGNING_KEY_REF === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['SIGNING_KEY_REF'],
      message: 'is required in production (file:// on a shared volume, or a KMS/Vault reference)',
    });
  }
});

/** Subset embedded in the browser bundle; Vite only exposes `VITE_`-prefixed variables. */
export const publicEnvSchema = z.object({
  VITE_APP_URL: requiredUrl(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type PublicEnv = z.infer<typeof publicEnvSchema>;

function describeIssue(issue: z.ZodIssue): string {
  if (issue.code === 'invalid_type') {
    const received =
      (issue as { input?: unknown; received?: unknown }).input ??
      (issue as { received?: unknown }).received;
    if (received === undefined) {
      return 'is required';
    }
  }
  return issue.message;
}

/**
 * Validates `source` against `schema` and throws one aggregated {@link EnvValidationError}
 * that lists every invalid or missing key, so startup fails fast with an actionable message.
 */
export function parseConfig<T>(schema: z.ZodType<T>, source: EnvSource): T {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => ({
        key: issue.path.length > 0 ? issue.path.join('.') : '(root)',
        message: describeIssue(issue),
      })),
    );
  }
  return result.data;
}

export const parseServerEnv = (source: EnvSource): ServerEnv =>
  parseConfig(serverEnvSchema, source);

export const parsePublicEnv = (source: EnvSource): PublicEnv =>
  parseConfig(publicEnvSchema, source);

const SENSITIVE_KEY = /(SECRET|PASSWORD|TOKEN|CREDENTIAL|PRIVATE|KEY)/i;

/** Returns a copy safe to log: sensitive keys are masked, everything else is stringified. */
export function redactConfig(config: Record<string, unknown>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SENSITIVE_KEY.test(key)) {
      safe[key] = value === undefined || value === null || value === '' ? '' : '***';
      continue;
    }
    safe[key] = Array.isArray(value) ? value.join(',') : String(value ?? '');
  }
  return safe;
}
