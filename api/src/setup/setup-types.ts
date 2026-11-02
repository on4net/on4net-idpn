/** Everything the wizard collects to create the first administrator. */
export interface InstallInput {
  username: string;
  email: string;
  displayName: string;
  /** Argon2id hash; the plain password never reaches the store. */
  passwordHash: string;
  /** Public origin of the admin panel; replaces the localhost redirect URIs when given. */
  adminUrl?: string;
  ip?: string | null;
  userAgent?: string | null;
}

export type InstallOutcome =
  | { ok: true; userId: string }
  /** The singleton marker already exists: the wizard is closed for good. */
  | { ok: false; reason: 'already_installed' }
  /** The email or username belongs to a different, already credentialed account. */
  | { ok: false; reason: 'conflict' };

export interface SetupStore {
  isInstalled(): Promise<boolean>;
  /** Seeds the catalog, creates the administrator and closes the wizard in one transaction. */
  install(input: InstallInput): Promise<InstallOutcome>;
}
