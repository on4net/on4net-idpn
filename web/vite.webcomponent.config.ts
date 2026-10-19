import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Web Component bundle: one ES module that registers `<on4net-idpn-user-management>`. */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@idpn/mfe-sdk': fileURLToPath(new URL('../packages/mfe-sdk/src/index.ts', import.meta.url)),
      '@idpn/contracts/theme': fileURLToPath(
        new URL('../packages/contracts/src/theme.ts', import.meta.url),
      ),
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist-wc',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: fileURLToPath(new URL('./src/mfe/web-component.tsx', import.meta.url)),
      formats: ['es'],
      fileName: 'web-component',
    },
  },
});
