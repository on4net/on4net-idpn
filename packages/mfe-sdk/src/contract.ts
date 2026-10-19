/**
 * Public contract of the on4net IDPN micro-frontends (docs/micro-frontend.md 5 and 6).
 *
 * This module is the only supported surface for host applications. It mirrors
 * `@idpn/contracts` (`MFE_SCHEMA_VERSION`); `contract.test.ts` fails whenever the two drift
 * apart.
 *
 * Security rules encoded here:
 * - no field may carry an access/refresh/ID token or a client secret;
 * - `clientId` is host configuration, never user input;
 * - `mode` selects how the host authenticates: `bff` (default, cookie) or `spa` (in-memory
 *   token getter for trusted hosts only).
 */

export const IDPN_MFE_MODULES = ['user-management', 'account'] as const;
export type IdpnMfeModule = (typeof IDPN_MFE_MODULES)[number];

export const IDPN_MFE_MODES = ['bff', 'spa'] as const;
export type IdpnMfeMode = (typeof IDPN_MFE_MODES)[number];

export const IDPN_MFE_DIRECTIONS = ['rtl', 'ltr'] as const;
export type IdpnDirection = (typeof IDPN_MFE_DIRECTIONS)[number];

export const IDPN_MFE_EVENT_TYPES = [
  'auth:login',
  'auth:logout',
  'auth:error',
  'profile:updated',
  'locale:changed',
  'context:changed',
  'navigation:request',
] as const;
export type IdpnEventType = (typeof IDPN_MFE_EVENT_TYPES)[number];

/** CSS custom properties the host may provide (docs/design-system.md 5). */
export type IdpnThemeTokens = Record<string, string>;

/** Non-sensitive user shape exposed in events. */
export interface IdpnPublicUser {
  id: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
}

export interface IdpnLocales {
  default: string;
  supported: readonly string[];
  dir: Readonly<Record<string, IdpnDirection>>;
}

export interface IdpnFeatures {
  selfServiceRegistration?: boolean;
  userManagement?: boolean;
  mfa?: boolean;
}

/**
 * Events emitted by every IDPN micro-frontend. No variant contains a token, a refresh
 * token or a client secret; hosts must treat them as UI hints only.
 */
export type IdpnEvent =
  | { type: 'auth:login'; user: IdpnPublicUser; loginContext: string }
  | { type: 'auth:logout'; reason: 'local' | 'global' | 'expired' }
  | { type: 'auth:error'; code: string }
  | { type: 'profile:updated'; user: IdpnPublicUser }
  | { type: 'locale:changed'; locale: string; dir: IdpnDirection }
  | { type: 'context:changed'; loginContext: string }
  | { type: 'navigation:request'; to: string };

export type IdpnEventHandler = (event: IdpnEvent) => void;

/**
 * Configuration contract shared by Module Federation hosts and Web Component hosts.
 *
 * The Web Component helper forwards `clientId`, `module`, `apiBaseUrl`, `locale`, `dir`
 * and `theme`; the remaining fields are consumed by Module Federation hosts (they belong
 * to the broader contract and are kept here so both setups use one type).
 */
export interface IdpnMfeConfig {
  /** Public client id registered in the IdP; host configuration, never user input. */
  clientId: string;
  module: IdpnMfeModule;
  /** `bff` (default and recommended) or `spa` (trusted hosts only). */
  mode: IdpnMfeMode;
  /** In BFF mode this is the host's `/auth` prefix; in SPA mode the IdP API origin. */
  apiBaseUrl: string;
  /** Hosted Auth UI address used for top-level redirects. */
  loginUrl?: string;
  locale?: string;
  /** Direction of the active locale; derived from `locale` when omitted. */
  dir?: IdpnDirection;
  locales?: IdpnLocales;
  /** Active login context of the host route; display only, authorization is server-side. */
  loginContext?: string;
  /** CSS custom properties mapped to `--<name>` and `--idpn-<name>` on the MFE root. */
  theme?: IdpnThemeTokens;
  basename?: string;
  features?: IdpnFeatures;
  /**
   * SPA mode only. Must return a token held in memory by the host; the SDK never stores,
   * logs or emits it and clears the getter when `mode` is `bff`.
   */
  getAccessToken?: () => string | null;
  /** Receives non-sensitive events; never receives a token. */
  onEvent?: IdpnEventHandler;
}

/** Attribute names set by the SDK helper. Never contains a token. */
export interface IdpnMfeElementAttributes {
  'client-id'?: string;
  'api-base'?: string;
  locale?: string;
  dir?: IdpnDirection;
  module?: IdpnMfeModule;
}

/**
 * Props accepted by the Web Component tags in JSX (React 19 assigns properties directly,
 * so `getAccessToken`, `onEvent` and `theme` stay in memory instead of the DOM).
 */
export interface IdpnMfeElementProps extends IdpnMfeElementAttributes {
  clientId?: string;
  apiBaseUrl?: string;
  getAccessToken?: () => string | null;
  onEvent?: IdpnEventHandler;
  theme?: IdpnThemeTokens;
}

/**
 * Common props of the React roots exposed through Module Federation. React itself is a
 * peer of the remote and is never bundled by this SDK.
 */
export interface IdpnReactModuleProps {
  clientId: string;
  apiBaseUrl?: string;
  locale?: string;
  dir?: IdpnDirection;
  theme?: IdpnThemeTokens;
  pageSize?: number;
  /** SPA mode only, `user-management` module only. */
  getAccessToken?: () => string | null;
  onEvent?: IdpnEventHandler;
}
