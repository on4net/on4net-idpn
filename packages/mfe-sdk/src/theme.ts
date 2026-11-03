/**
 * Per-client theme contract (docs/design-system.md 5).
 *
 * This is the publishable mirror of `@idpn/contracts/theme`; the SDK has no runtime
 * dependencies, so the type and the key lists are declared here and `contract.test.ts`
 * fails if they drift from the canonical schema. Sanitization happens inside the MFE
 * bundle (`IdpnRoot`) before any value reaches the DOM.
 */

export const IDPN_THEME_COLOR_KEYS = [
  'background',
  'foreground',
  'card',
  'primary',
  'primaryForeground',
  'secondary',
  'muted',
  'accent',
  'destructive',
  'border',
  'input',
  'ring',
] as const;
export type IdpnThemeColorKey = (typeof IDPN_THEME_COLOR_KEYS)[number];
export type IdpnThemeColors = Partial<Record<IdpnThemeColorKey, string>>;

export const IDPN_THEME_FONT_KEYS = ['vazirmatn', 'inter', 'system'] as const;
export type IdpnThemeFont = (typeof IDPN_THEME_FONT_KEYS)[number];

export interface IdpnThemeFontFamily {
  /** Font used when the active direction is RTL (fa-IR, ar-SA). */
  rtl?: IdpnThemeFont;
  /** Font used when the active direction is LTR (en-US). */
  ltr?: IdpnThemeFont;
}

export interface IdpnTheme extends IdpnThemeColors {
  /** Base corner radius; a single non-negative length (`0`, `8px`, `0.625rem`, `50%`). */
  radius?: string;
  /** Allowlisted font stacks per direction. */
  fontFamily?: IdpnThemeFontFamily;
  /** Optional dark-mode overrides for the same color keys. */
  dark?: IdpnThemeColors;
}

/** Default font per direction; a client may override it through `fontFamily`. */
export const IDPN_DEFAULT_FONTS: Readonly<Record<'rtl' | 'ltr', IdpnThemeFont>> = {
  rtl: 'vazirmatn',
  ltr: 'inter',
};

/** @deprecated Use {@link IdpnTheme}; kept so older host typings still compile. */
export type IdpnThemeTokens = IdpnTheme;
