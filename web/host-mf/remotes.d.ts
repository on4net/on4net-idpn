declare module 'idpnMfe/UserManagement' {
  import type { ComponentType } from 'react';

  const UserManagement: ComponentType<{
    clientId: string;
    apiBaseUrl?: string;
    getAccessToken?: () => string | null;
    locale?: string;
    dir?: 'rtl' | 'ltr';
    pageSize?: number;
  }>;

  export default UserManagement;
}

declare module 'idpnMfe/Account' {
  import type { ComponentType } from 'react';

  const Account: ComponentType<{
    apiBaseUrl?: string;
    clientId?: string;
    locale?: string;
    dir?: 'rtl' | 'ltr';
    onEvent?: (event: { type: 'auth:error'; code: string }) => void;
  }>;

  export default Account;
}
