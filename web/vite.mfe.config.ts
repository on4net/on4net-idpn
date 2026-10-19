import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { idpnScopeUtilities } from './src/styles/scope-utilities.ts';

/** Module Federation remote exposing the authenticated MFE modules. */
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // The remote CSS is injected into the host document; keep its utilities under `.idpn-root`.
    idpnScopeUtilities(),
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
    cors: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    headers: { 'Access-Control-Allow-Origin': '*' },
  },
});
