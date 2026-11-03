import type { IdpnTheme } from '@idpn/contracts/theme';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { mountAdminConsole } from '@/admin/mount';
import type { Locale } from '@/i18n';
import { AccountRoot } from '@/mfe/account';
import { UserManagementRoot } from '@/mfe/user-management';
import '@/styles/globals.css';

/**
 * Accessibility/visual test harness (development and Playwright only).
 *
 * `account`, `user-management` and the admin console have no standalone route in the
 * product: they are mounted by a host. This page mounts the real roots so the Playwright
 * suites can scan and photograph them with the same code the host uses.
 *
 * Vite serves it at `/harness/`; `vite build` only bundles `index.html`, so this file is
 * not part of a production build. Query parameters are test configuration and must never
 * be read by a product surface.
 */
if (import.meta.env.MODE === 'production') {
  throw new Error('The UI harness is not part of a production build.');
}

type Surface = 'account' | 'user-management' | 'admin';

const params = new URLSearchParams(window.location.search);
const requestedSurface = params.get('surface');
const surface: Surface =
  requestedSurface === 'user-management' || requestedSurface === 'admin'
    ? requestedSurface
    : 'account';
const locale: Locale = params.get('locale') === 'en-US' ? 'en-US' : 'fa-IR';
const dir = locale === 'en-US' ? 'ltr' : 'rtl';

document.documentElement.lang = locale;
document.documentElement.dir = dir;

const container = document.getElementById('harness-root');
if (container === null) {
  throw new Error('Missing #harness-root element');
}

/** Same token set the E2E host uses (docs/design-system.md 5). */
const theme: IdpnTheme = { primary: '#0057b8', radius: '8px' };

if (surface === 'admin') {
  container.classList.add('idpn-root');
  mountAdminConsole(container, { getToken: () => 'harness-token', locale, dir });
} else {
  createRoot(container).render(
    <StrictMode>
      {surface === 'user-management' ? (
        <UserManagementRoot clientId="app-a" locale={locale} theme={theme} />
      ) : (
        <AccountRoot locale={locale} theme={theme} />
      )}
    </StrictMode>,
  );
}
