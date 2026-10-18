import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const DEV_PORT = Number(process.env.VITE_PORT ?? 5173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
  },
});
