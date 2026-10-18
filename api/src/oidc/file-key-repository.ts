import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { SigningKeyRepository, SigningKeyStatus, StoredSigningKey } from './key-types.js';

interface SerializedKey {
  kid: string;
  alg: 'ES256';
  publicJwk: Record<string, unknown>;
  privateJwk: Record<string, unknown>;
  status: SigningKeyStatus;
  createdAt: string;
  retiredAt?: string | null;
}

/**
 * Development-only key store: a JSON file outside version control.
 *
 * Production must use KMS/Vault (docs/architecture.md 5); this repository exists so a local
 * instance keeps the same `kid` across restarts while no secret ever enters the repository.
 */
export class FileSigningKeyRepository implements SigningKeyRepository {
  constructor(private readonly filePath: string) {}

  async list(): Promise<StoredSigningKey[]> {
    const keys = await this.read();
    return keys.map(deserialize);
  }

  async save(key: StoredSigningKey): Promise<void> {
    const keys = await this.read();
    const next = keys.filter((entry) => entry.kid !== key.kid);
    next.push(serialize(key));
    await this.write(next);
  }

  async updateStatus(kid: string, status: SigningKeyStatus, retiredAt?: Date): Promise<void> {
    const keys = await this.read();
    const index = keys.findIndex((entry) => entry.kid === kid);
    if (index === -1) {
      return;
    }
    const current = keys[index];
    if (current === undefined) {
      return;
    }
    keys[index] = {
      ...current,
      status,
      retiredAt: retiredAt?.toISOString() ?? current.retiredAt ?? null,
    };
    await this.write(keys);
  }

  private async read(): Promise<SerializedKey[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as SerializedKey[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async write(keys: SerializedKey[]): Promise<void> {
    await mkdir(dirname(resolve(this.filePath)), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(keys, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}

function serialize(key: StoredSigningKey): SerializedKey {
  return {
    kid: key.kid,
    alg: key.alg,
    publicJwk: key.publicJwk as Record<string, unknown>,
    privateJwk: key.privateJwk as Record<string, unknown>,
    status: key.status,
    createdAt: key.createdAt.toISOString(),
    retiredAt: key.retiredAt?.toISOString() ?? null,
  };
}

function deserialize(key: SerializedKey): StoredSigningKey {
  return {
    kid: key.kid,
    alg: key.alg,
    publicJwk: key.publicJwk as StoredSigningKey['publicJwk'],
    privateJwk: key.privateJwk as StoredSigningKey['privateJwk'],
    status: key.status,
    createdAt: new Date(key.createdAt),
    retiredAt:
      key.retiredAt === null || key.retiredAt === undefined ? null : new Date(key.retiredAt),
  };
}
