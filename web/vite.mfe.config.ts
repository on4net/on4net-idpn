import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { idpnScopeUtilities } from './src/styles/scope-utilities.ts';
import { buildSecurityHeaders } from './src/security/headers.ts';
import { parseOrigins, remoteCorsPlugin } from './src/security/remote-cors.ts';

/**
 * Hosts allowed to import `remoteEntry.js`. Never `*`: the remote executes with the host's
 * privileges, so only the documented host origins may load it (docs/mfe-security.md).
 */
const ALLOWED_ORIGINS = parseOrigins(process.env.MFE_ALLOWED_ORIGINS, [
  'http://127.0.0.1:5176',
  'http://localhost:5176',
]);

/** Module Federation remote exposing the authenticated MFE modules. */
export default defineConfig({
  // The federated remote bundles `globals.css` only; it must not publish the IdP webfonts,
  // so an embedding host never requests `/fonts/*` from the IdP origin.
  publicDir: false,
  plugins: [
    react(),
    tailwindcss(),
    // The remote CSS is injected into the host document; keep its utilities under `.idpn-root`.
    idpnScopeUtilities(),
    remoteCorsPlugin(ALLOWED_ORIGINS),
    federation({
      name: 'idpnMfe',
      dts: false,
      filename: 'remoteEntry.js',
      manifest: true,
      exposes: {
        './UserManagement': './src/mfe/user-management.tsx',
        './Account': './src/mfe/account.tsx',
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
      '@idpn/contracts/theme': fileURLToPath(
        new URL('../packages/contracts/src/theme.ts', import.meta.url),
      ),
    },
  },
  build: {
    target: 'esnext',
    // Served by the host dev server from its public directory (same origin).
    outDir: 'host-mf/public/remote',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    // CORS is decided per request by `remoteCorsPlugin`; never enable Vite's wildcard CORS.
    headers: buildSecurityHeaders({ profile: 'remote', dev: true }),
  },
  preview: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    // The load suite reaches the preview server from the k6 container via this host alias.
    // Production serves the remote from a CDN, which has no Vite host check.
    allowedHosts: ['host.docker.internal'],
    headers: buildSecurityHeaders({ profile: 'remote', dev: false }),
  },
});
