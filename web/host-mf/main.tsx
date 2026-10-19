import { createRoot } from 'react-dom/client';
import type { ComponentType } from 'react';

import '@/styles/globals.css';
import './host-mf.css';

interface RemoteModule {
  default: ComponentType<{
    clientId: string;
    apiBaseUrl?: string;
    locale?: string;
    dir?: 'rtl' | 'ltr';
  }>;
}

async function bootstrap(): Promise<void> {
  const container = document.getElementById('host-root');
  if (container === null) {
    throw new Error('Missing #host-root element');
  }

  // Resolved through Module Federation; React is shared as a singleton and each
  // module brings its own `.idpn-root` and portal container. `clientId` is host
  // configuration and scopes every request to this app.
  const userManagement = (await import('idpnMfe/UserManagement')) as RemoteModule;
  const UserManagement = userManagement.default;
  createRoot(container).render(<UserManagement clientId="app-a" locale="fa-IR" dir="rtl" />);

  const accountContainer = document.getElementById('account-root');
  if (accountContainer !== null) {
    // The account module is same-origin with the IdP; this fixture has no IdP session,
    // so it renders its own safe error state without leaking anything to the host.
    const account = (await import('idpnMfe/Account')) as RemoteModule;
    const Account = account.default;
    createRoot(accountContainer).render(<Account clientId="app-a" locale="fa-IR" dir="rtl" />);
  }
}

void bootstrap();
