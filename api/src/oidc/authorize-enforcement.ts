import type { PrismaClient } from '../generated/prisma/client.js';
import type { MfaLoginRepository } from '../mfa/mfa-types.js';
import type {
  AuthorizeAuthenticationRequirement,
  AuthorizeMembershipStatus,
  AuthorizeSubjectInput,
} from './authorize-route.js';

type MfaPolicyReader = Pick<
  MfaLoginRepository,
  'resolveMfaPolicy' | 'resolveStepUpRequired' | 'isAdmin'
>;

/**
 * Resolves the authentication strength `/oauth2/authorize` must require before issuing a code
 * (`docs/login-contexts.md` 6, docs/security.md T31).
 *
 * The password login endpoint cannot enforce this reliably: its `clientId` is supplied by the
 * caller, and a session can also be created by the social callback or a passkey ceremony.
 * Enforcing at token issuance keeps one control for every session source.
 */
export function createAuthorizeAuthenticationRequirement(repository: MfaPolicyReader) {
  return async ({
    userId,
    clientId,
    loginContext,
  }: AuthorizeSubjectInput): Promise<AuthorizeAuthenticationRequirement> => {
    const input = { clientId, ...(loginContext === undefined ? {} : { loginContext }) };
    const policy = await repository.resolveMfaPolicy(input);
    const stepUpRequired = await repository.resolveStepUpRequired(input);
    const adminScoped =
      policy === 'required_admins' ? await repository.isAdmin(userId, clientId) : false;
    return {
      mfaRequired: stepUpRequired || policy === 'required_all' || adminScoped,
      freshAuthenticationRequired: stepUpRequired,
    };
  };
}

/**
 * Reads the user's membership for the client (and the login context, when one was requested).
 * `null` means the user holds no membership for that exact scope (`docs/login-contexts.md` 4.1).
 */
export function createAuthorizeMembershipStatus(prisma: PrismaClient) {
  return async ({
    userId,
    clientId,
    loginContext,
  }: AuthorizeSubjectInput): Promise<AuthorizeMembershipStatus | null> => {
    const client = await prisma.client.findUnique({
      where: { clientId },
      select: { id: true },
    });
    if (client === null) {
      return null;
    }
    const context =
      loginContext === undefined
        ? null
        : await prisma.clientLoginContext.findFirst({
            where: { clientId: client.id, key: loginContext },
            select: { id: true },
          });
    const membership = await prisma.clientMembership.findFirst({
      where: { clientId: client.id, userId, loginContextId: context?.id ?? null },
      select: { status: true },
    });
    return membership?.status ?? null;
  };
}
