import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { buildSecurityHeaders } from './src/security/headers.ts';
import { resolveRemoteEntry } from './src/security/targets.ts';

/** Independent React 19 host that consumes the `idpnMfe` remote. */
const REMOTE_ORIGINS_ALLOWED = (process.env.IDPN_REMOTE_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin !== '');
/**
 * The entry is validated before it reaches Module Federation: a same-origin path, or an
 * `https` URL whose origin is explicitly allowlisted. Its origin - and nothing else - is what
 * the CSP admits in `script-src`/`connect-src`, so a stray environment value cannot load code
 * into the host origin.
 */
const REMOTE = resolveRemoteEntry(process.env.IDPN_REMOTE_ENTRY, REMOTE_ORIGINS_ALLOWED);
const REMOTE_ENTRY = REMOTE.entry;
const REMOTE_ORIGINS = REMOTE.origins;
const IDP_ORIGINS = (process.env.IDPN_IDP_ORIGINS ?? process.env.VITE_API_PROXY ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin !== '');
/**
 * The IdP the host talks to. `/api` and `/auth` are proxied through the host origin so the
 * BFF cookie stays first-party and the baked-in `/auth/*` client calls resolve instead of
 * 404ing; `IDPN_IDP_ORIGIN` overrides the local default (docs/integration-guide.md).
 */
const IDP_TARGET = process.env.IDPN_IDP_ORIGIN ?? 'http://127.0.0.1:3000';
const devProxy = {
  '/api': { target: IDP_TARGET, changeOrigin: false },
  '/auth': { target: IDP_TARGET, changeOrigin: false },
};

export default defineConfig({
  root: fileURLToPath(new URL('./host-mf', import.meta.url)),
  plugins: [
    react(),
    tailwindcss(),
    federation({
      name: 'idpnHost',
      dts: false,
      remotes: {
        // Pin at least the major version (`.../idpn-mfe/1.4.0/remoteEntry.js` in production).
        idpnMfe: {
          type: 'module',
          name: 'idpnMfe',
          entry: REMOTE_ENTRY,
        },
      },
      shared: {
        react: { singleton: true, requiredVersion: '^19.0.0' },
        'react-dom': { singleton: true, requiredVersion: '^19.0.0' },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5176,
    strictPort: true,
    // The BFF and OIDC endpoints are same-origin through the host server.
    proxy: devProxy,
    headers: buildSecurityHeaders({
      profile: 'host',
      dev: true,
      idpOrigins: IDP_ORIGINS,
      remoteOrigins: REMOTE_ORIGINS,
      trustedTypesReportOnly: true,
    }),
  },
  preview: {
    host: '127.0.0.1',
    port: 5176,
    strictPort: true,
    proxy: devProxy,
    headers: buildSecurityHeaders({
      profile: 'host',
      dev: false,
      idpOrigins: IDP_ORIGINS,
      remoteOrigins: REMOTE_ORIGINS,
      trustedTypesReportOnly: true,
    }),
  },
  build: {
    target: 'esnext',
    outDir: fileURLToPath(new URL('./dist-host', import.meta.url)),
    emptyOutDir: true,
  },
});
