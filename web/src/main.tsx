import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { IdpnRoot } from './app/idpn-root';
import { LoginPage } from './app/login-page';
import './styles/globals.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element');
}

createRoot(container).render(
  <StrictMode>
    <IdpnRoot locale="fa-IR" dir="rtl">
      <LoginPage />
    </IdpnRoot>
  </StrictMode>,
);
