import { z } from 'zod';

import {
  DEFAULT_SOCIAL_SCOPES,
  SOCIAL_PROVIDERS,
  socialCallbackUrl,
  type AdminSocialProviderRepository,
  type SocialProvider,
} from '../admin/social-providers/social-provider-types.js';
import type { AdminRbacRepository } from '../admin/rbac/rbac-types.js';
import type { SecretBox } from '../crypto/secret-box.js';
import type { AppOnboardingConfig } from './app-config.js';
import {
  applyPermissionMapping,
  planPermissionMapping,
  rollbackPermissionMapping,
  type MappingApplyResult,
  type MappingOperation,
  type MappingRollbackResult,
  type MappingState,
} from './permission-mapping.js';
import {
  callbackUrlProblem,
  maskClientKey,
  type SocialCredentialLookup,
} from './social-credentials.js';

/**
 * Per-app onboarding orchestrator (`docs/runbooks/app-onboarding.md`).
 *
 * The IdP issues the credentials; the operator only registers the callback that this module
 * derives from the issuer. Provider secrets always pass through the existing AES-256-GCM
 * secret box (`api/src/crypto/secret-box.ts`) and never appear in the returned summary or in
 * the rollback state.
 */

export interface ClientOnboardingDependencies {
  providers: AdminSocialProviderRepository;
  rbac: AdminRbacRepository;
  /** `null` only outside production when no `SOCIAL_SECRET_KEY` is configured. */
  secretBox: SecretBox | null;
  /** Issuer base used to derive the exact callback registered in the provider console. */
  issuer: string;
  credentials: SocialCredentialLookup;
  nodeEnv?: string;
  now?: () => Date;
}

export type SocialAction = 'create' | 'update' | 'unchanged' | 'deleted' | 'kept' | 'error';

export interface SocialOperation {
  provider: SocialProvider;
  action: SocialAction;
  callbackUrl: string;
  /** Last four characters of the public client id; never the secret. */
  clientKeyHint: string | null;
  enabled: boolean;
  detail?: string;
}

export interface ClientOnboardingState {
  version: 1;
  generatedAt: string;
  clientId: string;
  issuer: string;
  socialProviders: {
    provider: SocialProvider;
    existed: boolean;
    callbackUrl: string;
  }[];
  mapping: MappingState;
}

const stateSchema = z.strictObject({
  version: z.literal(1),
  generatedAt: z.string().min(1),
  clientId: z.string().min(1),
  issuer: z.string().min(1),
  socialProviders: z.array(
    z.strictObject({
      provider: z.enum(SOCIAL_PROVIDERS),
      existed: z.boolean(),
      callbackUrl: z.string().min(1),
    }),
  ),
  mapping: z.strictObject({
    clientId: z.string().min(1),
    permissions: z.array(z.strictObject({ key: z.string().min(1), created: z.boolean() })),
    roles: z.array(
      z.strictObject({
        key: z.string().min(1),
        existed: z.boolean(),
        previous: z
          .strictObject({
            permissionKeys: z.array(z.string()),
            isDefault: z.boolean(),
          })
          .nullable(),
      }),
    ),
  }),
});

export interface StateParseResult {
  ok: boolean;
  state: ClientOnboardingState | null;
  problems: string[];
}

/** Validates a state file before a rollback; an unreadable state must never half-run. */
export function parseClientOnboardingState(value: unknown): StateParseResult {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      state: null,
      problems: parsed.error.issues.map((issue) => {
        const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
        return `${path}: ${issue.message}`;
      }),
    };
  }
  return { ok: true, state: parsed.data, problems: [] };
}

/**
 * Keeps the *first* observation of an item when an app is onboarded repeatedly.
 *
 * The second `apply` reports `existed: true` for everything the first run created; writing
 * that over the state would make a later rollback restore (or keep) instead of delete. The
 * union also keeps entries that were dropped from the config, so they can still be reverted.
 */
export function mergeOnboardingState(
  previous: ClientOnboardingState | null,
  next: ClientOnboardingState,
): ClientOnboardingState {
  if (previous === null || previous.clientId !== next.clientId) {
    return next;
  }
  const social = new Map(previous.socialProviders.map((entry) => [entry.provider, entry]));
  for (const entry of next.socialProviders) {
    if (!social.has(entry.provider)) {
      social.set(entry.provider, entry);
    }
  }
  const permissions = new Map(previous.mapping.permissions.map((entry) => [entry.key, entry]));
  for (const entry of next.mapping.permissions) {
    if (!permissions.has(entry.key)) {
      permissions.set(entry.key, entry);
    }
  }
  const roles = new Map(previous.mapping.roles.map((entry) => [entry.key, entry]));
  for (const entry of next.mapping.roles) {
    if (!roles.has(entry.key)) {
      roles.set(entry.key, entry);
    }
  }
  return {
    ...next,
    socialProviders: [...social.values()],
    mapping: {
      clientId: next.mapping.clientId,
      permissions: [...permissions.values()],
      roles: [...roles.values()],
    },
  };
}

export interface ClientOnboardingResult {
  dryRun: boolean;
  problems: string[];
  social: SocialOperation[];
  mapping: MappingOperation[];
  state: ClientOnboardingState | null;
}

const providersInConfig = (config: AppOnboardingConfig): SocialProvider[] =>
  SOCIAL_PROVIDERS.filter((provider) => config.socialProviders[provider] !== undefined);

interface SocialPlan {
  provider: SocialProvider;
  callbackUrl: string;
  existed: boolean;
  credentialConfigured: boolean;
  clientKeyHint: string | null;
}

/** Read-only validation shared by `--dry-run` and the real run. */
async function planSocial(
  config: AppOnboardingConfig,
  dependencies: ClientOnboardingDependencies,
): Promise<{ plans: SocialPlan[]; problems: string[] }> {
  const problems: string[] = [];
  const plans: SocialPlan[] = [];

  for (const provider of providersInConfig(config)) {
    const callbackUrl = socialCallbackUrl(dependencies.issuer, config.clientId, provider);
    const callbackProblem = callbackUrlProblem(callbackUrl, dependencies.nodeEnv);
    if (callbackProblem !== null) {
      problems.push(callbackProblem);
    }
    const credential = dependencies.credentials(config.clientId, provider);
    if (credential === null) {
      problems.push(
        `no credential configured for "${config.clientId}" / "${provider}"; set the ` +
          'referenced environment variable or add it to the secrets file',
      );
    } else if (dependencies.secretBox === null) {
      problems.push(
        'SOCIAL_SECRET_KEY is not configured: refusing to store a provider secret without ' +
          'encryption',
      );
    }
    const existing = await dependencies.providers.find(config.clientId, provider);
    if (!existing.ok) {
      problems.push(`client "${config.clientId}" does not exist`);
      continue;
    }
    plans.push({
      provider,
      callbackUrl,
      existed: existing.value !== null,
      credentialConfigured: credential !== null,
      clientKeyHint: credential === null ? null : maskClientKey(credential.clientKey),
    });
  }

  return { plans, problems };
}

export interface ApplyClientOnboardingOptions {
  config: AppOnboardingConfig;
  dryRun?: boolean;
  /** Skip provider credentials, e.g. to validate a mapping before the console work is done. */
  skipSocial?: boolean;
}

/** Applies credentials + mapping; refuses to write when any validation problem exists. */
export async function applyClientOnboarding(
  options: ApplyClientOnboardingOptions,
  dependencies: ClientOnboardingDependencies,
): Promise<ClientOnboardingResult> {
  const dryRun = options.dryRun ?? false;
  const now = dependencies.now ?? (() => new Date());
  const social: SocialOperation[] = [];

  const mappingPlan = planPermissionMapping(options.config);
  if (!mappingPlan.ok || mappingPlan.plan === null) {
    return {
      dryRun,
      problems: mappingPlan.problems,
      social,
      mapping: [],
      state: null,
    };
  }

  const socialPlan = options.skipSocial
    ? { plans: [], problems: [] }
    : await planSocial(options.config, dependencies);
  if (socialPlan.problems.length > 0) {
    return { dryRun, problems: socialPlan.problems, social, mapping: [], state: null };
  }

  // Writes only start here, after every input has been validated.
  for (const plan of socialPlan.plans) {
    const providerConfig = options.config.socialProviders[plan.provider];
    const credential = dependencies.credentials(options.config.clientId, plan.provider);
    if (providerConfig === undefined || credential === null || dependencies.secretBox === null) {
      social.push({
        provider: plan.provider,
        action: 'error',
        callbackUrl: plan.callbackUrl,
        clientKeyHint: plan.clientKeyHint,
        enabled: false,
        detail: 'credential or encryption key missing',
      });
      continue;
    }
    const scopes =
      providerConfig.scopes.length > 0 ? providerConfig.scopes : [...DEFAULT_SOCIAL_SCOPES];
    if (dryRun) {
      social.push({
        provider: plan.provider,
        action: plan.existed ? 'update' : 'create',
        callbackUrl: plan.callbackUrl,
        clientKeyHint: plan.clientKeyHint,
        enabled: providerConfig.enabled,
      });
      continue;
    }
    const saved = await dependencies.providers.upsert(options.config.clientId, plan.provider, {
      clientKey: credential.clientKey,
      scopes,
      allowedEmailDomains: providerConfig.allowedEmailDomains,
      enabled: providerConfig.enabled,
      clientSecretEncrypted: new Uint8Array(
        dependencies.secretBox.encrypt(credential.clientSecret),
      ),
    });
    if (!saved.ok) {
      social.push({
        provider: plan.provider,
        action: 'error',
        callbackUrl: plan.callbackUrl,
        clientKeyHint: plan.clientKeyHint,
        enabled: providerConfig.enabled,
        detail: `client "${options.config.clientId}" does not exist`,
      });
      continue;
    }
    social.push({
      provider: plan.provider,
      action: plan.existed ? 'update' : 'create',
      callbackUrl: plan.callbackUrl,
      clientKeyHint: plan.clientKeyHint,
      enabled: saved.value.enabled,
    });
  }

  const mapping = await applyPermissionMapping({
    rbac: dependencies.rbac,
    plan: mappingPlan.plan,
    dryRun,
  });

  const problems = [
    ...social
      .filter((operation) => operation.action === 'error')
      .map((operation) => `${operation.provider}: ${operation.detail ?? 'failed'}`),
    ...mapping.problems,
  ];
  if (problems.length > 0) {
    return { dryRun, problems, social, mapping: mapping.operations, state: null };
  }

  const state: ClientOnboardingState | null =
    dryRun || mapping.state === null
      ? null
      : {
          version: 1,
          generatedAt: now().toISOString(),
          clientId: options.config.clientId,
          issuer: dependencies.issuer.replace(/\/+$/, ''),
          socialProviders: socialPlan.plans.map((plan) => ({
            provider: plan.provider,
            existed: plan.existed,
            callbackUrl: plan.callbackUrl,
          })),
          mapping: mapping.state,
        };

  return { dryRun, problems: [], social, mapping: mapping.operations, state };
}

export interface SocialRollbackOperation {
  provider: SocialProvider;
  action: SocialAction;
  detail?: string;
}

export interface ClientRollbackResult {
  dryRun: boolean;
  problems: string[];
  social: SocialRollbackOperation[];
  mapping: MappingOperation[];
}

export interface RollbackClientOnboardingOptions {
  state: ClientOnboardingState;
  dryRun?: boolean;
}

/**
 * Reverts an apply step from its state file.
 *
 * A provider credential that existed before the run is *not* deleted: the previous ciphertext
 * is unrecoverable by design (the Admin API is write-only), so the operator must rotate or
 * re-register it. That case is reported as `kept` with the exact manual action.
 */
export async function rollbackClientOnboarding(
  options: RollbackClientOnboardingOptions,
  dependencies: ClientOnboardingDependencies,
): Promise<ClientRollbackResult> {
  const dryRun = options.dryRun ?? false;
  const problems: string[] = [];
  const social: SocialRollbackOperation[] = [];

  for (const entry of [...options.state.socialProviders].reverse()) {
    if (entry.existed) {
      social.push({
        provider: entry.provider,
        action: 'kept',
        detail:
          'the previous secret is not recoverable; re-register the archived credential or ' +
          'rotate it in the provider console',
      });
      continue;
    }
    if (!dryRun) {
      const removed = await dependencies.providers.remove(options.state.clientId, entry.provider);
      if (!removed.ok) {
        problems.push(`client "${options.state.clientId}" does not exist`);
        social.push({ provider: entry.provider, action: 'error', detail: 'client-not-found' });
        continue;
      }
    }
    social.push({ provider: entry.provider, action: 'deleted' });
  }

  const mapping: MappingRollbackResult = await rollbackPermissionMapping({
    rbac: dependencies.rbac,
    state: options.state.mapping,
    dryRun,
  });

  return {
    dryRun,
    problems: [...problems, ...mapping.problems],
    social,
    mapping: mapping.operations,
  };
}

export type { MappingApplyResult };
