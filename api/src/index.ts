import { loadApiEnv } from './config/env.js';
import { FileSigningKeyRepository } from './oidc/file-key-repository.js';
import { SigningKeyManager } from './oidc/keys.js';
import { buildServer } from './server.js';

const env = loadApiEnv();

// Development key store (git-ignored). Production points SIGNING_KEY_REF at KMS/Vault.
const keys = new SigningKeyManager(new FileSigningKeyRepository('.idpn-keys.json'));
await keys.ensureKey();

const app = buildServer({ issuer: env.APP_URL, keys });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
console.log(`on4net IDPN API listening on http://${env.HOST}:${env.PORT}`);
