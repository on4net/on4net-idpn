import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { AdminConsole } from '@/admin/admin-console';
import { createAdminApiClient, type AdminApiOptions } from '@/admin/api-client';
import { directionOf, type Locale } from '@/i18n';

export interface MountAdminConsoleOptions {
  /** Supplies the access token; the admin panel's BFF keeps it out of browser storage. */
  getToken: AdminApiOptions['getToken'];
  locale: Locale;
  /** Direction override from the validated admin config; derived from the locale otherwise. */
  dir?: 'rtl' | 'ltr';
  /** API origin when the panel and the API are on different hosts. */
  baseUrl?: string;
  pageSize?: number;
}

/**
 * Mounts the user-management console into `element`.
 *
 * The panel host owns authentication: it obtains an access token with the `idp.admin` scope
 * through its own BFF and passes a token getter here. Nothing in this module stores tokens.
 */
export function mountAdminConsole(element: HTMLElement, options: MountAdminConsoleOptions): Root {
  const client = createAdminApiClient({
    getToken: options.getToken,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });

  const root = createRoot(element);
  const dir = options.dir ?? directionOf(options.locale);
  element.setAttribute('dir', dir);
  element.setAttribute('lang', options.locale);
  root.render(
    <StrictMode>
      <AdminConsole
        client={client}
        locale={options.locale}
        signedOut={options.getToken() === null}
        {...(options.pageSize === undefined ? {} : { pageSize: options.pageSize })}
      />
    </StrictMode>,
  );
  return root;
}
