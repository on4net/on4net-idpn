/**
 * Key format and ownership rules for the per-client permission catalog
 * (docs/domain-model.md 2.8, 2.9, 3.3).
 */

const KEY_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_KEY_LENGTH = 160;
export const GLOBAL_KEY_PREFIX = 'idp';

export type KeyKind = 'permission' | 'role';

const SHAPE: Record<KeyKind, { segments: number; placeholder: string }> = {
  permission: { segments: 3, placeholder: '<clientId>:<resource>:<action>' },
  role: { segments: 2, placeholder: '<clientId>:<role>' },
};

/**
 * Validates a catalog key against its owning client.
 *
 * A client-owned key must start with its own `clientId` so a key can never be mistaken for
 * another app's catalog; global (`clientId = null`) keys use the reserved `idp` prefix.
 */
export function keyProblems(kind: KeyKind, key: string, clientId: string | null): string[] {
  const { segments, placeholder } = SHAPE[kind];
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    return [`${kind} key must be 1-${MAX_KEY_LENGTH} characters`];
  }

  const parts = key.split(':');
  if (parts.length !== segments) {
    return [`${kind} key must have the form ${placeholder}`];
  }

  const problems: string[] = [];
  for (const part of parts) {
    if (!KEY_SEGMENT.test(part)) {
      problems.push(
        `"${part}" must contain only lowercase letters, digits, dot, dash or underscore`,
      );
    }
  }

  const expectedPrefix = clientId ?? GLOBAL_KEY_PREFIX;
  if (parts[0] !== expectedPrefix) {
    problems.push(`${kind} key must start with "${expectedPrefix}"`);
  }

  return problems;
}

export const permissionKeyProblems = (key: string, clientId: string | null): string[] =>
  keyProblems('permission', key, clientId);

export const roleKeyProblems = (key: string, clientId: string | null): string[] =>
  keyProblems('role', key, clientId);

/**
 * Returns a problem when a permission may not be linked to a role.
 *
 * A role may only contain permissions of its own client or global permissions; a permission
 * owned by app A must never reach a role of app B.
 */
export function permissionOwnershipProblem(
  permissionClientId: string | null,
  roleClientId: string | null,
): string | null {
  if (permissionClientId === null || permissionClientId === roleClientId) {
    return null;
  }
  const roleScope = roleClientId ?? GLOBAL_KEY_PREFIX;
  return `permission of client "${permissionClientId}" cannot be linked to a role of client "${roleScope}"`;
}
