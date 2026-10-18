import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { HostedLoginPage } from './app/hosted-login';
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
