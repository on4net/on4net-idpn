import type { RegistrationPolicy } from './account-linking.js';
import type { SocialProviderId } from './types.js';

/**
 * Persistence and provider ports for the per-app social callback (`docs/auth-flows.md` 9.3).
 *
 * The repository is deliberately narrow: the route owns the linking policy, the repository only
 * performs the reads/writes and reports races instead of hiding them.
 */

export interface SocialClient {
  /** Internal UUID used by foreign keys. */
  id: string;
  /** Public client id from the callback path. */
  clientId: string;
  tenantId: string;
  status: 'active' | 'disabled';
  registrationPolicy: RegistrationPolicy;
  allowedEmailDomains: string[];
  /** Used to refuse social login for the administration panel (`docs/security.md` 3.4). */
  scopes: string[];
}

export interface SocialProviderCredentials {
  clientKey: string;
  /** AES-256-GCM envelope; only the callback handler decrypts it. */
  clientSecretEncrypted: Uint8Array;
  scopes: string[];
  allowedEmailDomains: string[];
  enabled: boolean;
}

export interface SocialIdentity {
  userId: string;
}

export type SocialUserStatus = 'active' | 'locked' | 'disabled' | 'pending';

export interface SocialUser {
  id: string;
  tenantId: string;
  email: string;
  emailVerifiedAt: Date | null;
  status: SocialUserStatus;
  deletedAt: Date | null;
}

export type MembershipStatus = 'invited' | 'active' | 'suspended';

export interface SocialMembership {
  id: string;
  status: MembershipStatus;
}

export interface CreateSocialUserInput {
  tenantId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  locale: string | null;
  /** When true the provider asserted the address and `email_verified_at` is stored. */
  emailVerified: boolean;
  now: Date;
}

export interface CreateSocialMembershipInput {
  /** Internal client UUID. */
  clientId: string;
  userId: string;
  joinedAt: Date;
}

export interface LinkIdentityInput {
  userId: string;
  provider: SocialProviderId;
  providerUserId: string;
  now: Date;
}

/**
 * `created: false` means the identity already existed for the same user (idempotent race).
 * `conflict` means another user owns that provider identity, including the case where this user
 * already linked a different identity of the same provider.
 */
export type LinkIdentityOutcome =
  { ok: true; created: boolean } | { ok: false; reason: 'conflict' };

export interface SocialLoginRepository {
  findClient(clientId: string): Promise<SocialClient | null>;
  findProvider(
    clientId: string,
    provider: SocialProviderId,
  ): Promise<SocialProviderCredentials | null>;
  findIdentity(provider: SocialProviderId, providerUserId: string): Promise<SocialIdentity | null>;
  findUserByEmail(tenantId: string, email: string): Promise<SocialUser | null>;
  findUserById(userId: string): Promise<SocialUser | null>;
  /**
   * Creates the central user. On an email unique-constraint race the existing user is returned
   * with `created: false`, so the caller can apply the linking rules to it.
   */
  createUser(input: CreateSocialUserInput): Promise<{ user: SocialUser; created: boolean }>;
  linkIdentity(input: LinkIdentityInput): Promise<LinkIdentityOutcome>;
  findMembership(clientId: string, userId: string): Promise<SocialMembership | null>;
  /** Creates an `active` membership; a concurrent insert returns the existing row. */
  createMembership(input: CreateSocialMembershipInput): Promise<SocialMembership>;
  activateMembership(membershipId: string, at: Date): Promise<SocialMembership>;
  /** Assigns the client's `is_default` roles; returns the assigned role keys. */
  assignDefaultRoles(input: { clientId: string; userId: string }): Promise<string[]>;
  markLogin(userId: string, at: Date): Promise<void>;
  /**
   * Best-effort cleanup of a user this flow just created when the identity link then loses a
   * unique-constraint race. Implementations must delete only when the user has no identities
   * and no memberships, so a concurrent successful login can never lose its account.
   */
  releaseUnlinkedUser(userId: string): Promise<void>;
}
