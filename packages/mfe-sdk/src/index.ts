/**
 * `@idpn/mfe-sdk` — typed contract and non-React mount helpers for the on4net IDPN
 * micro-frontends.
 *
 * The package is framework-agnostic and has no runtime dependencies. React hosts use the
 * Module Federation remotes; every other host uses the Web Component bundle and the
 * helpers exported here.
 *
 * ```ts
 * import { mountIdpnModule } from '@idpn/mfe-sdk';
 *
 * const mounted = mountIdpnModule(document.querySelector('#account')!, {
 *   clientId: 'app-a',
 *   module: 'account',
 *   mode: 'bff',
 *   apiBaseUrl: '/auth',
 *   locale: 'fa-IR',
 *   dir: 'rtl',
 * });
 *
 * mounted.unmount();
 * ```
 */

export {
  IDPN_MFE_DIRECTIONS,
  IDPN_MFE_EVENT_TYPES,
  IDPN_MFE_MODES,
  IDPN_MFE_MODULES,
} from './contract.js';
export type {
  IdpnDirection,
  IdpnEventHandler,
  IdpnEvent,
  IdpnEventType,
  IdpnFeatures,
  IdpnLocales,
  IdpnMfeConfig,
  IdpnMfeElementAttributes,
  IdpnMfeElementProps,
  IdpnMfeMode,
  IdpnMfeModule,
  IdpnPublicUser,
  IdpnReactModuleProps,
  IdpnThemeTokens,
} from './contract.js';

export {
  IDPN_MFE_MARKER_ATTRIBUTE,
  IDPN_MFE_TAGS,
  mountIdpnModule,
  unmountIdpnModule,
} from './mount.js';
export type { IdpnMfeElement, IdpnMountedModule } from './mount.js';

export { assertIdpnMfeConfig } from './validate.js';

export { IDPN_MFE_CONTRACT_VERSION, IDPN_MFE_SDK_VERSION } from './version.js';
