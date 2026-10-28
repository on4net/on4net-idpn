import { calculateJwkThumbprint, type JWK } from 'jose';

import type { KeyringSecretBox } from '../crypto/secret-box.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { SigningKeyConflictError } from './keys.js';
import type { SigningKeyRepository, SigningKeyStatus, StoredSigningKey } from './key-types.js';

/**
 * Signing keys in PostgreSQL, shared by every replica (card #78 section 1).
 *
 * A per-replica key file cannot work behind a load balancer: a token signed by one replica is
 * rejected by the next. This store keeps the public JWK in the clear (it is published in the
 * JWKS anyway) and the private JWK as an AES-256-GCM envelope under the signing-key wrap key
 * (`SIGNING_KEY_WRAP_KEY`), which the deployment injects from KMS/Vault. A database dump alone
 * therefore never contains a usable signing key, and the wrap key is rotated with the same key
 * ring and `ops:rewrap-secrets` as the other envelopes.
 *
 * `privateKeyRef` holds `enc:<base64 envelope>`. Concurrent rotations are arbitrated by the
 * partial unique index on active keys (migration 0014): the loser's insert fails instead of
 * leaving two active keys.
 */

const ENVELOPE_PREFIX = 'enc:';

/**
 * The public half is published in the JWKS and trusted by every relying party, but it sits in
 * PostgreSQL in the clear. Whoever can write that column could substitute their own public key
 * and have the IdP publish it, which lets them mint tokens the RPs accept. So the stored value
 * is never trusted: the public JWK is derived from the (authenticated) private JWK, must match
 * the stored copy member for member, and its RFC 7638 thumbprint must equal the row's `kid`.
 */
async function verifiedPublicJwk(
  row: { kid: string; publicKey: string },
  privateJwk: JWK,
): Promise<JWK> {
  const { kty, crv, x, y } = privateJwk;
  if (kty !== 'EC' || crv !== 'P-256' || x === undefined || y === undefined) {
    throw new Error(`signing key ${row.kid} is not an ES256 key`);
  }
  const derived: JWK = { kty, crv, x, y };
  const stored = JSON.parse(row.publicKey) as JWK;
  if (stored.kty !== kty || stored.crv !== crv || stored.x !== x || stored.y !== y) {
    throw new Error(`signing key ${row.kid}: stored public key does not match the private key`);
  }
  if ((await calculateJwkThumbprint(derived, 'sha256')) !== row.kid) {
    throw new Error(`signing key ${row.kid}: kid is not the thumbprint of the key`);
  }
  return derived;
}

export function createPrismaSigningKeyRepository(
  prisma: PrismaClient,
  box: KeyringSecretBox,
): SigningKeyRepository {
  const wrap = (privateJwk: JWK): string =>
    `${ENVELOPE_PREFIX}${box.encrypt(JSON.stringify(privateJwk)).toString('base64')}`;

  const unwrap = (reference: string, kid: string): JWK => {
    if (!reference.startsWith(ENVELOPE_PREFIX)) {
      // A plain reference (an external KMS handle) is not something this store can sign with.
      throw new Error(`signing key ${kid} is not stored as an encrypted envelope`);
    }
    const plaintext = box.decrypt(Buffer.from(reference.slice(ENVELOPE_PREFIX.length), 'base64'));
    return JSON.parse(plaintext) as JWK;
  };

  return {
    async list() {
      const rows = await prisma.signingKey.findMany({ orderBy: { createdAt: 'asc' } });
      return Promise.all(
        rows.map(async (row): Promise<StoredSigningKey> => {
          const privateJwk = unwrap(row.privateKeyRef, row.kid);
          return {
            kid: row.kid,
            alg: 'ES256',
            publicJwk: await verifiedPublicJwk(row, privateJwk),
            privateJwk,
            status: row.status,
            createdAt: row.createdAt,
            retiredAt: row.retiredAt,
          };
        }),
      );
    },

    async save(key) {
      const data = {
        publicKey: JSON.stringify(key.publicJwk),
        privateKeyRef: wrap(key.privateJwk),
        status: key.status,
        createdAt: key.createdAt,
        retiredAt: key.retiredAt ?? null,
      };
      try {
        await prisma.signingKey.upsert({
          where: { kid: key.kid },
          create: { kid: key.kid, alg: 'ES256', ...data },
          update: data,
        });
      } catch (error) {
        // P2002: the partial unique index on active keys (migration 0014) rejected a second one.
        if ((error as { code?: unknown }).code === 'P2002' && key.status === 'active') {
          throw new SigningKeyConflictError();
        }
        throw error;
      }
    },

    async updateStatus(kid: string, status: SigningKeyStatus, retiredAt?: Date) {
      // Unknown kids are ignored, like the file store: the caller already read the key list.
      await prisma.signingKey.updateMany({
        where: { kid },
        data: { status, ...(retiredAt === undefined ? {} : { retiredAt }) },
      });
    },
  };
}
