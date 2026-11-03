import type { IdpnMfeModule } from '@idpn/mfe-sdk';

import type { RemoteLoader } from './IdpnModuleHost';

/**
 * Dynamic imports resolved by Module Federation.
 *
 * The remote entry (name `idpnMfe`, React/ReactDOM shared as singletons) is pinned in
 * `vite.host.config.ts` through `IDPN_REMOTE_ENTRY`; in production it points at an
 * immutable, versioned CDN URL such as
 * `https://cdn.example.com/idpn-mfe/1.4.0/remoteEntry.js`.
 *
 * The imports stay inside these functions so a failed remote rejects the lazy component
 * instead of crashing the host bundle at startup.
 */
const loadUserManagement: RemoteLoader = () => import('idpnMfe/UserManagement');
const loadAccount: RemoteLoader = () => import('idpnMfe/Account');

export const remoteLoaders: Record<IdpnMfeModule, RemoteLoader> = {
  'user-management': loadUserManagement,
  account: loadAccount,
};
