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

/** Variables required by the API/Auth Server process, as documented in docs/architecture.md §5. */
export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
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
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).max(1_048_576).default(65_536),
  ARGON2_TIME_COST: z.coerce.number().int().min(1).max(10).default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(8).default(1),
  SIGNING_KEY_REF: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  MFE_PUBLIC_URL: optionalUrl(),
  /**
   * Public origin of the Hosted Auth UI. Defaults to `APP_URL` (single-origin deployment);
   * set it when the UI is served from a different host or port than the API.
   */
  HOSTED_UI_URL: optionalUrl(),
  /** Version of the published MFE bundle (used for the remoteEntry URL). */
  MFE_VERSION: z.preprocess(emptyToUndefined, z.string().min(1).default('0.1.0')),
  MFE_ALLOWED_ORIGINS: csv(origin).default([]),
  SOCIAL_CALLBACK_BASE_URL: optionalUrl(),
  SMTP_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .url()
      .refine((value) => /^smtps?:\/\//.test(value), 'must be an smtp:// or smtps:// URL')
      .optional(),
  ),
  TRUSTED_PROXY_CIDRS: csv(z.string().min(1)).default([]),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
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
