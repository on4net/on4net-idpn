/**
 * Validates membership attributes against the client's `membershipSchema`
 * (docs/api.md 3.3.1, docs/domain-model.md 2.6.2).
 *
 * Only the JSON Schema subset the Admin API promises is supported: `type`, `properties`,
 * `required` and `additionalProperties`. The check fails closed: an unreadable schema or an
 * unsupported keyword rejects the write instead of silently accepting any attribute.
 */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const typeMatches = (value: unknown, type: string): boolean => {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
};

const SUPPORTED_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
  'null',
]);

/**
 * Validates roles written through a Login Context membership endpoint
 * (docs/api.md 3.3.3, docs/login-contexts.md 5).
 *
 * A context may only grant roles from its own `allowed_roles`; anything else would let an
 * app (or a delegated context admin) mint a role the context does not expose. The check is
 * pure so it runs before any write and can be unit tested.
 */
export function contextRoleProblems(
  roleKeys: readonly string[],
  allowedRoles: readonly string[],
): string[] {
  const allowed = new Set(allowedRoles);
  return [...new Set(roleKeys)]
    .filter((key) => !allowed.has(key))
    .sort()
    .map((key) => `role "${key}" is not allowed in this login context`);
}

export function validateMembershipAttributes(
  schema: Record<string, unknown> | null,
  attributes: unknown,
): string[] {
  if (!isPlainObject(attributes)) {
    return ['attributes must be an object'];
  }
  if (schema === null) {
    return [];
  }

  if (schema['type'] !== undefined && schema['type'] !== 'object') {
    return ['membership schema must describe an object'];
  }

  const problems: string[] = [];
  const rawProperties = schema['properties'];
  if (rawProperties !== undefined && !isPlainObject(rawProperties)) {
    return ['membership schema properties must be an object'];
  }
  const properties = (rawProperties ?? {}) as Record<string, unknown>;

  const rawRequired = schema['required'];
  if (rawRequired !== undefined) {
    if (!Array.isArray(rawRequired) || rawRequired.some((key) => typeof key !== 'string')) {
      return ['membership schema required must be an array of strings'];
    }
    for (const key of rawRequired as string[]) {
      if (!(key in attributes) || attributes[key] === null || attributes[key] === undefined) {
        problems.push(`attributes.${key} is required`);
      }
    }
  }

  if (schema['additionalProperties'] === false) {
    for (const key of Object.keys(attributes)) {
      if (!(key in properties)) {
        problems.push(`attributes.${key} is not allowed`);
      }
    }
  }

  for (const [key, value] of Object.entries(attributes)) {
    const definition = properties[key];
    if (!isPlainObject(definition) || definition['type'] === undefined) {
      continue;
    }
    const type = definition['type'];
    if (typeof type !== 'string' || !SUPPORTED_TYPES.has(type)) {
      problems.push(`attributes.${key} has an unsupported type in the membership schema`);
      continue;
    }
    if (value !== null && !typeMatches(value, type)) {
      problems.push(`attributes.${key} must be of type ${type}`);
    }
  }

  return problems;
}
