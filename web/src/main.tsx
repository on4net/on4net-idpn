import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { HostedLoginPage } from './app/hosted-login';
// Hosted-only assets: the MFE bundles `globals.css` alone and never fetches these files.
import './styles/fonts.css';
import './styles/globals.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element');
}

createRoot(container).render(
  <StrictMode>
    <HostedLoginPage />
  </StrictMode>,
);
