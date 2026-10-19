import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';

/**
 * Thin port over `@simplewebauthn/server` (`docs/security.md` 3.3).
 *
 * The library performs the cryptographic checks (CBOR parsing, attestation/assertion
 * signature, `rpIdHash`, flags). The surrounding service still validates the challenge,
 * ceremony type, origin allowlist and sign counter itself, so those controls stay testable
 * without a real authenticator and are not silently delegated.
 */

/** All-zero AAGUID means the authenticator did not report a model identifier. */
const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';

export interface WebauthnRegistrationOptions {
  rpId: string;
  rpName: string;
  userName: string;
  userDisplayName?: string;
  userId: Uint8Array<ArrayBuffer>;
  excludeCredentials: { id: string; transports?: string[] }[];
}

export interface WebauthnAuthenticationOptions {
  rpId: string;
  allowCredentials: { id: string; transports?: string[] }[];
  userVerification: 'required' | 'preferred';
}

export interface WebauthnRegistrationVerification {
  response: unknown;
  expectedChallenge: string;
  expectedOrigins: readonly string[];
  expectedRpId: string;
  requireUserVerification: boolean;
}

export interface VerifiedWebauthnRegistration {
  verified: true;
  credential: {
    /** Base64url credential id as returned by the authenticator. */
    id: string;
    publicKey: Uint8Array;
    counter: number;
    transports: string[];
    aaguid: string | null;
    deviceType: string | null;
    backedUp: boolean;
  };
  userVerified: boolean;
}

export interface WebauthnAuthenticationVerification {
  response: unknown;
  expectedChallenge: string;
  expectedOrigins: readonly string[];
  expectedRpId: string;
  requireUserVerification: boolean;
  credential: {
    id: string;
    publicKey: Uint8Array;
    counter: number;
    transports: string[];
  };
}

export type WebauthnVerificationResult<T> = { verified: true; value: T } | { verified: false };

export interface WebauthnLibrary {
  generateRegistrationOptions(
    input: WebauthnRegistrationOptions,
  ): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challenge: string }>;
  generateAuthenticationOptions(
    input: WebauthnAuthenticationOptions,
  ): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challenge: string }>;
  verifyRegistration(
    input: WebauthnRegistrationVerification,
  ): Promise<WebauthnVerificationResult<VerifiedWebauthnRegistration['credential']>>;
  verifyAuthentication(
    input: WebauthnAuthenticationVerification,
  ): Promise<WebauthnVerificationResult<{ newCounter: number }>>;
}

const transportsOf = (response: unknown): string[] => {
  const candidate = (response as { response?: { transports?: unknown } } | null)?.response;
  const transports = candidate?.transports;
  if (!Array.isArray(transports)) {
    return [];
  }
  return transports.filter((entry): entry is string => typeof entry === 'string').slice(0, 10);
};

/** Default implementation backed by `@simplewebauthn/server`. */
export class SimpleWebauthnLibrary implements WebauthnLibrary {
  async generateRegistrationOptions(input: WebauthnRegistrationOptions) {
    const options = await generateRegistrationOptions({
      rpID: input.rpId,
      rpName: input.rpName,
      userName: input.userName,
      ...(input.userDisplayName === undefined ? {} : { userDisplayName: input.userDisplayName }),
      userID: input.userId,
      excludeCredentials: input.excludeCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
      attestationType: 'none',
    });
    return { options, challenge: options.challenge };
  }

  async generateAuthenticationOptions(input: WebauthnAuthenticationOptions) {
    const options = await generateAuthenticationOptions({
      rpID: input.rpId,
      allowCredentials: input.allowCredentials,
      userVerification: input.userVerification,
    });
    return { options, challenge: options.challenge };
  }

  async verifyRegistration(
    input: WebauthnRegistrationVerification,
  ): Promise<WebauthnVerificationResult<VerifiedWebauthnRegistration['credential']>> {
    const result = await verifyRegistrationResponse({
      response: input.response as RegistrationResponseJSON,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: [...input.expectedOrigins],
      expectedRPID: input.expectedRpId,
      requireUserVerification: input.requireUserVerification,
    });
    if (!result.verified) {
      return { verified: false };
    }
    const { credential, aaguid, credentialDeviceType, credentialBackedUp } =
      result.registrationInfo;
    const reported = transportsOf(input.response);
    return {
      verified: true,
      value: {
        id: credential.id,
        publicKey: new Uint8Array(credential.publicKey),
        counter: credential.counter,
        transports: reported.length > 0 ? reported : (credential.transports ?? []),
        aaguid: aaguid === ZERO_AAGUID ? null : aaguid,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
      },
    };
  }

  async verifyAuthentication(
    input: WebauthnAuthenticationVerification,
  ): Promise<WebauthnVerificationResult<{ newCounter: number }>> {
    const credential: WebAuthnCredential = {
      id: input.credential.id,
      publicKey: new Uint8Array(input.credential.publicKey),
      counter: input.credential.counter,
      transports: input.credential.transports,
    };
    const result = await verifyAuthenticationResponse({
      response: input.response as AuthenticationResponseJSON,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: [...input.expectedOrigins],
      expectedRPID: input.expectedRpId,
      credential,
      requireUserVerification: input.requireUserVerification,
    });
    if (!result.verified) {
      return { verified: false };
    }
    return { verified: true, value: { newCounter: result.authenticationInfo.newCounter } };
  }
}
