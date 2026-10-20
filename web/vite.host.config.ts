import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { buildSecurityHeaders } from './src/security/headers.ts';

/** Independent React 19 host that consumes the `idpnMfe` remote. */
const REMOTE_ENTRY = process.env.IDPN_REMOTE_ENTRY ?? '/remote/remoteEntry.js';
/** Only an absolute remote entry contributes a CDN origin to the host CSP. */
const REMOTE_ORIGINS = /^https?:\/\//i.test(REMOTE_ENTRY) ? [new URL(REMOTE_ENTRY).origin] : [];
const IDP_ORIGINS = (process.env.IDPN_IDP_ORIGINS ?? process.env.VITE_API_PROXY ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin !== '');

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
