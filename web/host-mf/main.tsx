import { createRoot } from 'react-dom/client';
import type { ComponentType } from 'react';

import '@/styles/globals.css';
import './host-mf.css';

interface RemoteModule {
  default: ComponentType<{ locale?: string; dir?: 'rtl' | 'ltr' }>;
}

async function bootstrap(): Promise<void> {
  const container = document.getElementById('host-root');
  if (container === null) {
    throw new Error('Missing #host-root element');
  }

  // Resolved through Module Federation; React is shared as a singleton and the
  // module brings its own `.idpn-root` and portal container.
  const remote = (await import('idpnMfe/UserManagement')) as unknown as RemoteModule;
  const UserManagement = remote.default;

  createRoot(container).render(<UserManagement locale="fa-IR" dir="rtl" />);
}

void bootstrap();
