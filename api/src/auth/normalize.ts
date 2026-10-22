/**
 * Emails and usernames are case-insensitive (docs/domain-model.md 2.2) and the database
 * enforces lowercase values with CHECK constraints, so normalization happens here.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** Best-effort display form for logs/notifications; empty when the value cannot be parsed. */
export function maskEmail(email: string): string {
  const [local, domain] = normalizeEmail(email).split('@');
  if (local === undefined || domain === undefined || local === '') {
    return '***';
  }
  const visible = local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
}
