import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';

import { loadApiEnv } from './config/env.js';
import { PrismaClient } from './generated/prisma/client.js';
import { FileSigningKeyRepository } from './oidc/file-key-repository.js';
import { SigningKeyManager } from './oidc/keys.js';
import { createPrismaClientRepository } from './oidc/prisma-client-repository.js';
import { createPrismaCodeRepository } from './oidc/prisma-code-repository.js';
import { createPrismaRefreshTokenRepository } from './oidc/prisma-refresh-repository.js';
import { createPrismaUserRepository } from './oidc/prisma-user-repository.js';
import { createPrismaPublicConfigRepository } from './public-config/prisma-repository.js';
import { buildServer } from './server.js';
import { RedisSessionCache } from './session/redis-cache.js';
import { RedisSessionStore } from './session/store.js';

const env = loadApiEnv();

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });

// Development key store (git-ignored). Production points SIGNING_KEY_REF at KMS/Vault.
const keys = new SigningKeyManager(new FileSigningKeyRepository('.idpn-keys.json'));
await keys.ensureKey();

const sessions = new RedisSessionStore({
  cache: new RedisSessionCache(redis),
  policy: {
    idleTtlSeconds: env.SESSION_IDLE_TTL_SECONDS,
    absoluteTtlSeconds: env.SESSION_ABSOLUTE_TTL_SECONDS,
  },
});

const clientsRepository = createPrismaClientRepository(prisma);
const usersRepository = createPrismaUserRepository(prisma);

const app = buildServer({
  issuer: env.APP_URL,
  keys,
  token: {
    clients: clientsRepository,
    codes: createPrismaCodeRepository(prisma),
    refreshTokens: createPrismaRefreshTokenRepository(prisma),
    users: usersRepository,
    sessions,
  },
  userInfo: { users: usersRepository },
  publicConfig: {
    repository: createPrismaPublicConfigRepository(prisma),
    originLookup: (clientId) => clientsRepository.findAllowedOrigins(clientId),
    mfe: {
      version: env.MFE_VERSION,
      remoteEntry: `${(env.MFE_PUBLIC_URL ?? env.APP_URL).replace(/\/+$/, '')}/${env.MFE_VERSION}/remoteEntry.js`,
    },
    translationsUrlTemplate: `${env.APP_URL.replace(/\/+$/, '')}/api/v1/clients/{clientId}/translations/bundle`,
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => prisma.$disconnect())
      .then(() => redis.quit())
      .then(() => process.exit(0));
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
console.log(`on4net IDPN API listening on http://${env.HOST}:${env.PORT}`);
