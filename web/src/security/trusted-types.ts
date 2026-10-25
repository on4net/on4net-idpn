/**
 * Trusted Types policy `idpn` (docs/security.md 7).
 *
 * The CSP names exactly one allowed policy, `idpn`. The policy is deliberately a refusal:
 * the Hosted UI never turns a string into HTML, a script or a script URL (React renders
 * through the DOM API), so every sink call that would need a Trusted Type throws instead of
 * silently accepting attacker-influenced text. Registering it up front also means a library
 * that tries to create its own policy is reported by the browser rather than quietly
 * widening what the page trusts.
 */

export const TRUSTED_TYPES_POLICY_NAME = 'idpn';

interface TrustedTypePolicyFactoryLike {
  createPolicy(
    name: string,
    rules: {
      createHTML?: (input: string) => string;
      createScript?: (input: string) => string;
      createScriptURL?: (input: string) => string;
    },
  ): unknown;
}

const refuse = (sink: string) => (): never => {
  throw new TypeError(`idpn Trusted Types policy: ${sink} is not permitted`);
};

/**
 * Creates the policy once. Returns `false` when the browser has no Trusted Types support or
 * the policy already exists (the CSP allows duplicates), and never throws on startup.
 */
export function installTrustedTypesPolicy(
  scope: { trustedTypes?: TrustedTypePolicyFactoryLike } = globalThis as {
    trustedTypes?: TrustedTypePolicyFactoryLike;
  },
): boolean {
  const factory = scope.trustedTypes;
  if (factory === undefined) {
    return false;
  }
  try {
    factory.createPolicy(TRUSTED_TYPES_POLICY_NAME, {
      createHTML: refuse('HTML'),
      createScript: refuse('script'),
      createScriptURL: refuse('script URL'),
    });
    return true;
  } catch {
    return false;
  }
}
