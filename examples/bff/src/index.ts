import { buildBffApp } from './app.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required (see examples/bff/README.md)`);
  }
  return value;
}

const port = Number(process.env.BFF_PORT ?? 3200);
const host = process.env.BFF_HOST ?? '127.0.0.1';
const idpBaseUrl = requireEnv('IDP_URL');
const publicUrl = process.env.BFF_PUBLIC_URL ?? `http://${host}:${port}`;

const app = buildBffApp({
  idp: {
    baseUrl: idpBaseUrl,
    clientId: requireEnv('BFF_CLIENT_ID'),
    clientSecret: requireEnv('BFF_CLIENT_SECRET'),
    redirectUri: process.env.BFF_REDIRECT_URI ?? `${publicUrl}/auth/callback`,
    scopes: (process.env.BFF_SCOPES ?? 'openid profile email offline_access')
      .split(/\s+/)
      .filter(Boolean),
  },
  hostedLoginUrl: process.env.HOSTED_UI_URL ?? `${idpBaseUrl.replace(/\/+$/, '')}/`,
  secureCookies: idpBaseUrl.startsWith('https://'),
  logger: true,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port, host });
