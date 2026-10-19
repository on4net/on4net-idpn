import type {
  IdpnDirection,
  IdpnEventHandler,
  IdpnMfeConfig,
  IdpnMfeMode,
  IdpnMfeModule,
  IdpnTheme,
} from '@idpn/mfe-sdk';

/**
 * `@idpn/mfe-sdk` rejects an empty `apiBaseUrl`, while an empty `VITE_IDPN_API_BASE_URL`
 * means "same origin" for the host. A single `/` strips to the same origin in both API
 * clients, so the host maps it here instead of weakening the SDK guard.
 */
export const SAME_ORIGIN_API_BASE = '/';

/** Host-owned settings shared by every module of one page. */
export interface HostModuleSettings {
  readonly clientId: string;
  readonly mode: IdpnMfeMode;
  readonly apiBaseUrl: string;
  readonly locale: string;
  readonly dir: IdpnDirection;
  readonly theme?: IdpnTheme;
  readonly onEvent: IdpnEventHandler;
  /** SPA mode only; returns a token held in host memory. */
  readonly getAccessToken?: () => string | null;
}

/**
 * Builds the SDK config for one module (docs/mfe-sdk.md 3.1).
 *
 * - `apiBaseUrl: ''` (same-origin BFF) is forwarded as `/`.
 * - The in-memory token getter is forwarded only in `spa` mode and only to
 *   `user-management`; the `account` module is documented as BFF-only and always
 *   authenticates with the IdP session cookie.
 * - `clientId`, `mode` and `apiBaseUrl` come from host configuration, never from the URL
 *   or other user input.
 */
export function toMfeConfig(settings: HostModuleSettings, module: IdpnMfeModule): IdpnMfeConfig {
  const getAccessToken =
    settings.mode === 'spa' && module === 'user-management' ? settings.getAccessToken : undefined;

  return {
    clientId: settings.clientId,
    module,
    mode: settings.mode,
    apiBaseUrl: settings.apiBaseUrl === '' ? SAME_ORIGIN_API_BASE : settings.apiBaseUrl,
    locale: settings.locale,
    dir: settings.dir,
    ...(settings.theme === undefined ? {} : { theme: settings.theme }),
    onEvent: settings.onEvent,
    ...(getAccessToken === undefined ? {} : { getAccessToken }),
  };
}
