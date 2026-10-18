import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Independent React 19 host that consumes the `idpnMfe` remote. */
export default defineConfig({
  root: fileURLToPath(new URL('./host-mf', import.meta.url)),
  plugins: [
    react(),
    tailwindcss(),
    federation({
      name: 'idpnHost',
      dts: false,
      remotes: {
        idpnMfe: {
          type: 'module',
          name: 'idpnMfe',
          entry: 'http://127.0.0.1:5174/remoteEntry.js',
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
  },
  preview: {
    host: '127.0.0.1',
    port: 5176,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    outDir: fileURLToPath(new URL('./dist-host', import.meta.url)),
    emptyOutDir: true,
  },
});
