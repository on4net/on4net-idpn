declare module 'idpnMfe/UserManagement' {
  import type { ComponentType } from 'react';

  const UserManagement: ComponentType<{
    locale?: string;
    dir?: 'rtl' | 'ltr';
    initialUsers?: readonly { id: string; name: string; email: string }[];
  }>;

  export default UserManagement;
}
