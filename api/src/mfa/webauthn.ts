import { createHash } from 'node:crypto';

import type {
  CreateWebauthnCredentialResult,
  MfaFactorRecord,
  NewWebauthnCredential,
} from './mfa-types.js';
import {
  type WebauthnCeremony,
  type WebauthnChallengeRecord,
  type WebauthnChallengeStore,
  type WebauthnPurpose,
} from './webauthn-challenge-store.js';
import type { WebauthnLibrary, WebauthnRegistrationOptions } from './webauthn-library.js';

/**
 * WebAuthn/passkey ceremonies (`docs/auth-flows.md` 7.2, `docs/security.md` 3.3).
 *
 * Every ceremony is bound to a single-use challenge record holding the user, ceremony,
 * purpose, RP ID and origin allowlist. Verification checks the client data *before* the
 * cryptographic verification, then the library verifies the signature/attestation, and
 * finally the sign counter is compared and advanced with a compare-and-set. A cloned
 * authenticator (counter regression), a replayed ceremony and a foreign origin all fail.
 */

export class WebauthnConfigError extends Error {
  override readonly name = 'WebauthnConfigError';
}

export interface WebauthnConfig {
  /** RP ID is the hostname of `APP_URL`; it must be a suffix of every accepted origin. */
  rpId: string;
  rpName: string;
  /** `APP_URL` origin first, then the configured allowlist. */
  origins: string[];
}

const normalizeHostname = (value: string): string => value.toLowerCase().replace(/\.$/, '');

/**
 * Derives the RP ID and origin allowlist from validated configuration.
 *
 * `APP_URL` is already validated as an absolute URL by the env schema; additionally every
 * allowlisted origin must be an origin (no path) whose host is the RP ID or a subdomain of
 * it, as browsers require. An invalid entry fails startup instead of weakening checks.
 */
export function resolveWebauthnConfig(input: {
  appUrl: string;
  allowedOrigins?: readonly string[];
  rpName?: string;
}): WebauthnConfig {
  let appUrl: URL;
  try {
    appUrl = new URL(input.appUrl);
  } catch {
    throw new WebauthnConfigError('APP_URL must be an absolute URL');
  }
  const rpId = normalizeHostname(appUrl.hostname);
  if (rpId === '') {
    throw new WebauthnConfigError('APP_URL must include a hostname');
  }
  const origins = [appUrl.origin];
  for (const candidate of input.allowedOrigins ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new WebauthnConfigError('a WebAuthn allowed origin is not a valid URL');
    }
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      throw new WebauthnConfigError('a WebAuthn allowed origin must not carry a path or query');
    }
    const hostname = normalizeHostname(parsed.hostname);
    if (hostname !== rpId && !hostname.endsWith(`.${rpId}`)) {
      throw new WebauthnConfigError('a WebAuthn allowed origin is outside the RP ID');
    }
    if (!origins.includes(parsed.origin)) {
      origins.push(parsed.origin);
    }
  }
  return { rpId, rpName: input.rpName ?? rpId, origins };
}

export interface ParsedClientData {
  type: string;
  challenge: string;
  origin: string;
}

export type ClientDataFailure =
  | 'invalid_client_data'
  | 'cross_origin'
  | 'ceremony_mismatch'
  | 'challenge_mismatch'
  | 'origin_not_allowed';

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const MAX_CLIENT_DATA_BYTES = 8192;

const decodeClientData = (value: unknown): unknown => {
  if (typeof value !== 'string' || value.length === 0 || !BASE64URL.test(value)) {
    return null;
  }
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length === 0 || bytes.length > MAX_CLIENT_DATA_BYTES) {
      return null;
    }
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return null;
  }
};

const clientDataValue = (response: unknown): unknown =>
  (response as { response?: { clientDataJSON?: unknown } } | null)?.response?.clientDataJSON;

const EXPECTED_TYPE: Record<WebauthnCeremony, string> = {
  registration: 'webauthn.create',
  authentication: 'webauthn.get',
};

/**
 * Validates the collected client data: ceremony type, challenge, origin allowlist and the
 * cross-origin flag. Pure and synchronous so the security checks are directly unit-testable.
 */
export function checkClientData(
  record: WebauthnChallengeRecord,
  response: unknown,
): { ok: true; clientData: ParsedClientData } | { ok: false; reason: ClientDataFailure } {
  const parsed = decodeClientData(clientDataValue(response));
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, reason: 'invalid_client_data' };
  }
  const data = parsed as Partial<ParsedClientData> & { crossOrigin?: unknown };
  if (data.crossOrigin === true) {
    return { ok: false, reason: 'cross_origin' };
  }
  if (typeof data.type !== 'string' || typeof data.challenge !== 'string') {
    return { ok: false, reason: 'invalid_client_data' };
  }
  if (typeof data.origin !== 'string') {
    return { ok: false, reason: 'invalid_client_data' };
  }
  if (data.type !== EXPECTED_TYPE[record.ceremony]) {
    return { ok: false, reason: 'ceremony_mismatch' };
  }
  if (data.challenge !== record.challenge) {
    return { ok: false, reason: 'challenge_mismatch' };
  }
  if (!record.origins.includes(data.origin)) {
    return { ok: false, reason: 'origin_not_allowed' };
  }
  return {
    ok: true,
    clientData: { type: data.type, challenge: data.challenge, origin: data.origin },
  };
}

/** The persistence the ceremony needs; every lookup is scoped to the owning `userId`. */
export interface WebauthnRepository {
  listConfirmedWebauthn(userId: string): Promise<MfaFactorRecord[]>;
  findWebauthn(userId: string, factorId: string): Promise<MfaFactorRecord | null>;
  findWebauthnByCredentialId(
    userId: string,
    credentialId: Uint8Array,
  ): Promise<MfaFactorRecord | null>;
  createWebauthnCredential(
    userId: string,
    credential: NewWebauthnCredential,
    at: Date,
  ): Promise<CreateWebauthnCredentialResult>;
  updateWebauthnCounter(
    factorId: string,
    userId: string,
    expectedCounter: bigint,
    newCounter: bigint,
    at: Date,
  ): Promise<boolean>;
  renameFactor(factorId: string, userId: string, name: string): Promise<boolean>;
  deleteFactor(factorId: string, userId: string): Promise<boolean>;
}

export interface WebauthnServiceDependencies {
  config: WebauthnConfig;
  challenges: WebauthnChallengeStore;
  repository: WebauthnRepository;
  library: WebauthnLibrary;
  now?: () => Date;
}

export type WebauthnFailure =
  | 'challenge_invalid'
  | 'invalid_client_data'
  | 'cross_origin'
  | 'ceremony_mismatch'
  | 'challenge_mismatch'
  | 'origin_not_allowed'
  | 'verification_failed'
  | 'duplicate_credential'
  | 'credential_unknown'
  | 'counter_regression'
  | 'mfa_challenge_mismatch'
  | 'no_credentials';

export interface BeginRegistrationInput {
  userId: string;
  tenantId: string;
  userName: string;
  userDisplayName?: string;
}

export async function beginRegistration(
  deps: WebauthnServiceDependencies,
  input: BeginRegistrationInput,
): Promise<{
  ok: true;
  challengeId: string;
  options: Awaited<ReturnType<WebauthnLibrary['generateRegistrationOptions']>>['options'];
}> {
  const existing = await deps.repository.listConfirmedWebauthn(input.userId);
  const registrationInput: WebauthnRegistrationOptions = {
    rpId: deps.config.rpId,
    rpName: deps.config.rpName,
    userName: input.userName,
    ...(input.userDisplayName === undefined ? {} : { userDisplayName: input.userDisplayName }),
    userId: new Uint8Array(userHandle(input.userId)),
    excludeCredentials: existing.flatMap((factor) =>
      factor.credentialId === null
        ? []
        : [
            {
              id: factor.credentialId.toString('base64url'),
              ...(factor.transports.length === 0 ? {} : { transports: factor.transports }),
            },
          ],
    ),
  };
  const { options, challenge } = await deps.library.generateRegistrationOptions(registrationInput);
  const created = await deps.challenges.create({
    challenge,
    userId: input.userId,
    tenantId: input.tenantId,
    ceremony: 'registration',
    purpose: 'enroll',
    rpId: deps.config.rpId,
    origins: deps.config.origins,
    ...(deps.now === undefined ? {} : { now: deps.now() }),
  });
  return { ok: true, challengeId: created.id, options };
}

export interface FinishRegistrationInput {
  userId: string;
  challengeId: string;
  response: unknown;
  name: string;
}

export async function finishRegistration(
  deps: WebauthnServiceDependencies,
  input: FinishRegistrationInput,
): Promise<
  | { ok: true; factorId: string; name: string; credentialId: string }
  | { ok: false; reason: WebauthnFailure }
> {
  const record = await deps.challenges.consume(input.challengeId);
  if (record === null || record.userId !== input.userId || record.ceremony !== 'registration') {
    return { ok: false, reason: 'challenge_invalid' };
  }
  const checked = checkClientData(record, input.response);
  if (!checked.ok) {
    return { ok: false, reason: checked.reason };
  }
  let verification: Awaited<ReturnType<WebauthnLibrary['verifyRegistration']>>;
  try {
    verification = await deps.library.verifyRegistration({
      response: input.response,
      expectedChallenge: record.challenge,
      expectedOrigins: record.origins,
      expectedRpId: record.rpId,
      requireUserVerification: false,
    });
  } catch {
    // Malformed attestation/CBOR must fail the ceremony, never surface as a 500.
    return { ok: false, reason: 'verification_failed' };
  }
  if (!verification.verified) {
    return { ok: false, reason: 'verification_failed' };
  }
  const at = (deps.now ?? (() => new Date()))();
  const credential = verification.value;
  const created = await deps.repository.createWebauthnCredential(
    input.userId,
    {
      name: input.name,
      credentialId: Buffer.from(credential.id, 'base64url'),
      publicKey: credential.publicKey,
      signCount: BigInt(Math.max(0, Math.trunc(credential.counter))),
      transports: credential.transports,
      aaguid: credential.aaguid,
      deviceType: credential.deviceType,
      backedUp: credential.backedUp,
    },
    at,
  );
  if (!created.ok) {
    return { ok: false, reason: 'duplicate_credential' };
  }
  return {
    ok: true,
    factorId: created.factor.id,
    name: created.factor.name,
    credentialId: credential.id,
  };
}

export interface BeginAuthenticationInput {
  userId: string;
  tenantId: string;
  purpose: WebauthnPurpose;
  /** Required for `purpose = login`: binds the ceremony to the pending MFA challenge. */
  mfaChallengeToken?: string;
}

export async function beginAuthentication(
  deps: WebauthnServiceDependencies,
  input: BeginAuthenticationInput,
): Promise<
  | {
      ok: true;
      challengeId: string;
      options: Awaited<ReturnType<WebauthnLibrary['generateAuthenticationOptions']>>['options'];
    }
  | { ok: false; reason: 'no_credentials' }
> {
  const credentials = await deps.repository.listConfirmedWebauthn(input.userId);
  const allowCredentials = credentials.flatMap((factor) =>
    factor.credentialId === null
      ? []
      : [
          {
            id: factor.credentialId.toString('base64url'),
            ...(factor.transports.length === 0 ? {} : { transports: factor.transports }),
          },
        ],
  );
  if (allowCredentials.length === 0) {
    return { ok: false, reason: 'no_credentials' };
  }
  const { options, challenge } = await deps.library.generateAuthenticationOptions({
    rpId: deps.config.rpId,
    allowCredentials,
    userVerification: 'required',
  });
  const created = await deps.challenges.create({
    challenge,
    userId: input.userId,
    tenantId: input.tenantId,
    ceremony: 'authentication',
    purpose: input.purpose,
    rpId: deps.config.rpId,
    origins: deps.config.origins,
    ...(input.mfaChallengeToken === undefined
      ? {}
      : { mfaChallengeToken: input.mfaChallengeToken }),
    ...(deps.now === undefined ? {} : { now: deps.now() }),
  });
  return { ok: true, challengeId: created.id, options };
}

export interface FinishAuthenticationInput {
  userId: string;
  challengeId: string;
  response: unknown;
  purpose: WebauthnPurpose;
  mfaChallengeToken?: string;
}

export async function finishAuthentication(
  deps: WebauthnServiceDependencies,
  input: FinishAuthenticationInput,
): Promise<
  { ok: true; factorId: string; newCounter: number } | { ok: false; reason: WebauthnFailure }
> {
  const record = await deps.challenges.consume(input.challengeId);
  if (record === null || record.userId !== input.userId || record.ceremony !== 'authentication') {
    return { ok: false, reason: 'challenge_invalid' };
  }
  if (record.purpose !== input.purpose) {
    return { ok: false, reason: 'challenge_invalid' };
  }
  if (record.mfaChallengeToken !== undefined) {
    if (
      input.mfaChallengeToken === undefined ||
      record.mfaChallengeToken !== input.mfaChallengeToken
    ) {
      return { ok: false, reason: 'mfa_challenge_mismatch' };
    }
  } else if (input.purpose === 'login') {
    return { ok: false, reason: 'mfa_challenge_mismatch' };
  }

  const checked = checkClientData(record, input.response);
  if (!checked.ok) {
    return { ok: false, reason: checked.reason };
  }
  const credentialId = credentialIdOf(input.response);
  if (credentialId === null) {
    return { ok: false, reason: 'invalid_client_data' };
  }
  const factor = await deps.repository.findWebauthnByCredentialId(input.userId, credentialId);
  if (
    factor === null ||
    factor.confirmedAt === null ||
    factor.credentialId === null ||
    factor.publicKey === null
  ) {
    return { ok: false, reason: 'credential_unknown' };
  }

  let verification: Awaited<ReturnType<WebauthnLibrary['verifyAuthentication']>>;
  try {
    verification = await deps.library.verifyAuthentication({
      response: input.response,
      expectedChallenge: record.challenge,
      expectedOrigins: record.origins,
      expectedRpId: record.rpId,
      requireUserVerification: true,
      credential: {
        id: factor.credentialId.toString('base64url'),
        publicKey: factor.publicKey,
        counter: Number(factor.signCount),
        transports: factor.transports,
      },
    });
  } catch {
    // Malformed authenticator data must fail the assertion, never surface as a 500.
    return { ok: false, reason: 'verification_failed' };
  }
  if (!verification.verified) {
    return { ok: false, reason: 'verification_failed' };
  }

  const newCounter = BigInt(Math.max(0, Math.trunc(verification.value.newCounter)));
  // A counter that does not advance (when the stored one is non-zero) is evidence of a
  // cloned authenticator or a replayed assertion; both fail closed.
  if (factor.signCount > 0n && newCounter <= factor.signCount) {
    return { ok: false, reason: 'counter_regression' };
  }
  const at = (deps.now ?? (() => new Date()))();
  const advanced = await deps.repository.updateWebauthnCounter(
    factor.id,
    input.userId,
    factor.signCount,
    newCounter,
    at,
  );
  if (!advanced) {
    // Another request consumed the same assertion between our read and the update.
    return { ok: false, reason: 'counter_regression' };
  }
  return { ok: true, factorId: factor.id, newCounter: Number(newCounter) };
}

export async function renameCredential(
  deps: WebauthnServiceDependencies,
  input: { userId: string; factorId: string; name: string },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
  const renamed = await deps.repository.renameFactor(input.factorId, input.userId, input.name);
  return renamed ? { ok: true } : { ok: false, reason: 'not_found' };
}

export async function deleteCredential(
  deps: WebauthnServiceDependencies,
  input: { userId: string; factorId: string },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
  const deleted = await deps.repository.deleteFactor(input.factorId, input.userId);
  return deleted ? { ok: true } : { ok: false, reason: 'not_found' };
}

const CREDENTIAL_ID = /^[A-Za-z0-9_-]+={0,2}$/;

function credentialIdOf(response: unknown): Buffer | null {
  const id = (response as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !CREDENTIAL_ID.test(id)) {
    return null;
  }
  const bytes = Buffer.from(id, 'base64url');
  return bytes.length === 0 || bytes.length > 1024 ? null : bytes;
}

/** WebAuthn user handles are opaque bytes; a UUID is used directly, anything else is hashed. */
function userHandle(userId: string): Uint8Array {
  const uuid = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(
    userId,
  );
  if (uuid !== null) {
    return Buffer.from(userId.replace(/-/g, ''), 'hex');
  }
  return createHash('sha256').update(userId, 'utf8').digest();
}
