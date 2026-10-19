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
