declare module 'idpnMfe/UserManagement' {
  import type { ComponentType } from 'react';
  import type { IdpnReactModuleProps } from '@idpn/mfe-sdk';

  const UserManagement: ComponentType<IdpnReactModuleProps>;
  export default UserManagement;
}

declare module 'idpnMfe/Account' {
  import type { ComponentType } from 'react';
  import type { IdpnReactModuleProps } from '@idpn/mfe-sdk';

  const Account: ComponentType<IdpnReactModuleProps>;
  export default Account;
}
