import { beforeEach, describe, expect, it, vi } from 'vitest';

const webauthn = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  browserSupportsWebAuthn: vi.fn(),
}));

vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: webauthn.startRegistration,
  startAuthentication: webauthn.startAuthentication,
  browserSupportsWebAuthn: webauthn.browserSupportsWebAuthn,
}));

import { browserPasskeyDriver, passkeysSupported, type PasskeyDriver } from './passkey-client';

beforeEach(() => {
  webauthn.startRegistration.mockReset();
  webauthn.startAuthentication.mockReset();
  webauthn.browserSupportsWebAuthn.mockReset();
});

describe('browserPasskeyDriver', () => {
  it('reports browser support and delegates both ceremonies to the library', async () => {
    webauthn.browserSupportsWebAuthn.mockReturnValue(true);
    webauthn.startRegistration.mockResolvedValue({ id: 'credential-1' });
    webauthn.startAuthentication.mockResolvedValue({ id: 'credential-1' });

    expect(browserPasskeyDriver.supported()).toBe(true);
    const creation = { challenge: 'creation' } as never;
    const request = { challenge: 'request' } as never;

    await expect(browserPasskeyDriver.register(creation)).resolves.toEqual({
      id: 'credential-1',
    });
    await expect(browserPasskeyDriver.authenticate(request)).resolves.toEqual({
      id: 'credential-1',
    });
    expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: creation });
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: request });
  });

  it('reports unsupported when the browser has no WebAuthn API', () => {
    webauthn.browserSupportsWebAuthn.mockReturnValue(false);
    expect(passkeysSupported()).toBe(false);
  });
});

describe('passkeysSupported', () => {
  it('returns true for a driver that supports passkeys', () => {
    const driver: PasskeyDriver = {
      supported: () => true,
      register: vi.fn(),
      authenticate: vi.fn(),
    };
    expect(passkeysSupported(driver)).toBe(true);
  });

  it('fails closed when the driver throws', () => {
    const driver: PasskeyDriver = {
      supported: () => {
        throw new Error('no authenticator');
      },
      register: vi.fn(),
      authenticate: vi.fn(),
    };
    expect(passkeysSupported(driver)).toBe(false);
  });
});
