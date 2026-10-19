import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

/**
 * Browser side of the WebAuthn ceremonies.
 *
 * Only the platform authenticator API is used; the server decides whether a ceremony is
 * allowed and verifies the signed response. The prompt/response never contains a token, and
 * nothing is persisted in storage. The interface is a test seam so jsdom tests never need a
 * real authenticator.
 */
export interface PasskeyDriver {
  supported(): boolean;
  register(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON>;
  authenticate(options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON>;
}

export class PasskeyUnsupportedError extends Error {
  override readonly name = 'PasskeyUnsupportedError';
}

export const browserPasskeyDriver: PasskeyDriver = {
  supported() {
    return typeof window !== 'undefined' && browserSupportsWebAuthn();
  },
  async register(options) {
    return startRegistration({ optionsJSON: options });
  },
  async authenticate(options) {
    return startAuthentication({ optionsJSON: options });
  },
};

/** True when the browser can perform a ceremony; tests can inject a driver instead. */
export function passkeysSupported(driver: PasskeyDriver = browserPasskeyDriver): boolean {
  try {
    return driver.supported();
  } catch {
    return false;
  }
}
