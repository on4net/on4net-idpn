import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

import { buildSecurityHeaders } from './src/security/headers.ts';

/** Mirrors the API default in `@idpn/config` and the ports documented in docs/setup.md. */
const DEFAULT_API_PORT = 6000;
const DEFAULT_WEB_PORT = 6001;
/** Repo-root `.env`, so `PORT`, `VITE_PORT` and `VITE_API_PROXY` are honoured from the file too. */
const ENV_DIR = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  // The empty prefix loads `PORT` as well: it has no `VITE_` prefix but drives the dev proxy.
  const env = loadEnv(mode, ENV_DIR, '');
  const devPort = Number(env.VITE_PORT || DEFAULT_WEB_PORT);
  const apiProxy = env.VITE_API_PROXY || `http://127.0.0.1:${env.PORT || DEFAULT_API_PORT}`;
  const idpOrigins = (env.IDPN_IDP_ORIGINS || apiProxy)
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        // The host fixture consumes the published SDK entry, not a deep import.
        '@idpn/mfe-sdk': fileURLToPath(
          new URL('../packages/mfe-sdk/src/index.ts', import.meta.url),
        ),
        '@idpn/contracts/theme': fileURLToPath(
          new URL('../packages/contracts/src/theme.ts', import.meta.url),
        ),
      },
    },
    server: {
      host: '127.0.0.1',
      port: devPort,
      strictPort: true,
      // Hosted UI policy (docs/mfe-security.md). Dev adds Vite's inline preamble and HMR
      // socket; production keeps script-src at 'self' and never allows eval.
      headers: buildSecurityHeaders({
        profile: 'hosted',
        dev: true,
        idpOrigins,
        trustedTypesReportOnly: true,
      }),
      proxy: {
        // The Hosted UI talks to the API on the IdP origin; the dev proxy keeps cookies
        // first-party and avoids CORS in local development.
        '/api': apiProxy,
        '/oauth2': apiProxy,
        '/.well-known': apiProxy,
      },
    },
    preview: {
      host: '127.0.0.1',
      port: devPort,
      strictPort: true,
      headers: buildSecurityHeaders({
        profile: 'hosted',
        dev: false,
        idpOrigins,
        trustedTypesReportOnly: true,
      }),
    },
  };
});
