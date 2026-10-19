/** Public profile of the signed-in user (docs/account-api.md). */
export type AccountUserStatus = 'active' | 'locked' | 'disabled' | 'pending';

export interface AccountProfile {
  id: string;
  username: string;
  email: string;
  displayName: string;
  phone: string | null;
  avatarUrl: string | null;
  locale: string;
  status: AccountUserStatus;
  emailVerified: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  passwordChangedAt: string | null;
}

/** Persistence port for the self-service account profile. */
export interface AccountProfileRepository {
  findById(userId: string): Promise<AccountProfile | null>;
}
