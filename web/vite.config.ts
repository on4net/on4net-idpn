import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { buildSecurityHeaders } from './src/security/headers.ts';

const DEV_PORT = Number(process.env.VITE_PORT ?? 5173);
const API_PROXY = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:3000';
const IDP_ORIGINS = (process.env.IDPN_IDP_ORIGINS ?? API_PROXY)
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin !== '');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The host fixture consumes the published SDK entry, not a deep import.
      '@idpn/mfe-sdk': fileURLToPath(new URL('../packages/mfe-sdk/src/index.ts', import.meta.url)),
      '@idpn/contracts/theme': fileURLToPath(
        new URL('../packages/contracts/src/theme.ts', import.meta.url),
      ),
    },
  },
  server: {
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
    // Hosted UI policy (docs/mfe-security.md). Dev adds Vite's inline preamble and HMR
    // socket; production keeps script-src at 'self' and never allows eval.
    headers: buildSecurityHeaders({
      profile: 'hosted',
      dev: true,
      idpOrigins: IDP_ORIGINS,
      trustedTypesReportOnly: true,
    }),
    proxy: {
      // The Hosted UI talks to the API on the IdP origin; the dev proxy keeps cookies
      // first-party and avoids CORS in local development.
      '/api': API_PROXY,
      '/oauth2': API_PROXY,
      '/.well-known': API_PROXY,
    },
  },
  preview: {
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
    headers: buildSecurityHeaders({
      profile: 'hosted',
      dev: false,
      idpOrigins: IDP_ORIGINS,
      trustedTypesReportOnly: true,
    }),
  },
});
