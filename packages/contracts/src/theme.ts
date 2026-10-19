import { z } from 'zod';

/**
 * Per-client theme contract (docs/design-system.md 5, docs/api.md 2.7).
 *
 * The shape is intentionally flat for light tokens so the public config stays compatible
 * with the documented `{ "primary": "#0f766e", "radius": "8px" }` payload. Dark overrides
 * live under `dark` and carry the same color keys.
 *
 * Security rules:
 * - every value is validated against a strict grammar; free-form CSS is never accepted;
 * - `sanitizeIdpnTheme` drops invalid or unknown fields instead of throwing, so a bad
 *   branding row can never break the public config or inject a rule into the page;
 * - `idpnThemeToCssVariables` emits `--idpn-*` names only (never `--primary` directly).
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
  /** Allowlisted font stacks per direction (docs/design-system.md 6). */
  fontFamily?: IdpnThemeFontFamily;
  /** Optional dark-mode overrides for the same color keys. */
  dark?: IdpnThemeColors;
}

/** Default font per direction; the client may override through `fontFamily`. */
export const IDPN_DEFAULT_FONTS: Readonly<Record<'rtl' | 'ltr', IdpnThemeFont>> = {
  rtl: 'vazirmatn',
  ltr: 'inter',
};

/**
 * Fixed font stacks. Values are constants, never built from client input, so a branding
 * row can only select a stack (no arbitrary font URLs or CSS injection).
 */
export const IDPN_THEME_FONT_STACKS: Readonly<Record<IdpnThemeFont, string>> = {
  vazirmatn: "'Vazirmatn', 'Inter', system-ui, sans-serif",
  inter: "'Inter', 'Vazirmatn', system-ui, sans-serif",
  system: 'system-ui, -apple-system, sans-serif',
};

const COLOR_VARIABLE_SUFFIX: Readonly<Record<IdpnThemeColorKey, string>> = {
  background: 'background',
  foreground: 'foreground',
  card: 'card',
  primary: 'primary',
  primaryForeground: 'primary-foreground',
  secondary: 'secondary',
  muted: 'muted',
  accent: 'accent',
  destructive: 'destructive',
  border: 'border',
  input: 'input',
  ring: 'ring',
};

const MAX_COLOR_LENGTH = 80;
const MAX_RADIUS_LENGTH = 16;
const MAX_FONT_LENGTH = 32;

/**
 * Defence in depth: the parsers below are allowlists, but these sequences are rejected
 * explicitly so a regression in a pattern cannot open a CSS injection path.
 */
const FORBIDDEN_CSS = /[;{}<>\\"'`\r\n]|url\s*\(|expression\s*\(|javascript\s*:|var\s*\(|@import/i;

const SAFE_NAMED_COLORS = new Set(['transparent', 'black', 'white', 'currentcolor']);

const UNSIGNED = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
/** A channel followed by an optional `%`. */
const CHANNEL = String.raw`(${UNSIGNED}%?)`;
const ALPHA = String.raw`(${UNSIGNED}%?)`;
const SEPARATOR = String.raw`\s*(?:,|\s)\s*`;

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_COLOR = new RegExp(
  String.raw`^rgba?\(\s*${CHANNEL}${SEPARATOR}${CHANNEL}${SEPARATOR}${CHANNEL}(?:\s*[,/]\s*${ALPHA})?\s*\)$`,
  'i',
);
const HSL_COLOR = new RegExp(
  String.raw`^hsla?\(\s*(${NUMBER}(?:deg|grad|rad|turn)?)${SEPARATOR}(${UNSIGNED})%\s*(?:,|\s)\s*(${UNSIGNED})%(?:\s*[,/]\s*${ALPHA})?\s*\)$`,
  'i',
);
const OKLCH_COLOR = new RegExp(
  String.raw`^oklch\(\s*(${UNSIGNED}%?)\s+(${UNSIGNED}%?)\s+(${NUMBER}(?:deg)?)\s*(?:/\s*${ALPHA})?\s*\)$`,
  'i',
);
const RADIUS = /^(?:0|(?:\d{1,4})(?:\.\d{1,4})?(?:px|rem|em|%))$/;
/** Family names accepted from branding; the renderer emits the fixed stack. */
const FONT_ALIASES: Readonly<Record<string, IdpnThemeFont>> = {
  vazirmatn: 'vazirmatn',
  inter: 'inter',
  system: 'system',
  'system-ui': 'system',
  'ui-sans-serif': 'system',
  'sans-serif': 'system',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numeric = (value: string): number => Number.parseFloat(value);

const parseChannel = (raw: string, max: number): boolean => {
  const value = numeric(raw);
  if (!Number.isFinite(value) || value < 0) return false;
  return raw.endsWith('%') ? value <= 100 : value <= max;
};

const parseAlpha = (raw: string | undefined): boolean => {
  if (raw === undefined) return true;
  const value = numeric(raw);
  if (!Number.isFinite(value) || value < 0) return false;
  return raw.endsWith('%') ? value <= 100 : value <= 1;
};

const parseHue = (raw: string): boolean => {
  const value = numeric(raw);
  if (!Number.isFinite(value) || value < 0) return false;
  if (raw.endsWith('turn')) return value <= 1;
  if (raw.endsWith('grad')) return value <= 400;
  if (raw.endsWith('rad')) return value <= Math.PI * 2;
  return value <= 360;
};

const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ');

/**
 * Returns a normalized color, or `undefined` when the value is not a well-formed CSS color
 * from the accepted grammar. Accepted: hex, `rgb()/rgba()`, `hsl()/hsla()`, `oklch()` and
 * a tiny named-color allowlist.
 */
export function sanitizeIdpnColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = normalize(value);
  if (candidate === '' || candidate.length > MAX_COLOR_LENGTH) return undefined;
  if (FORBIDDEN_CSS.test(candidate)) return undefined;

  const named = candidate.toLowerCase();
  if (SAFE_NAMED_COLORS.has(named)) return named;

  if (HEX_COLOR.test(candidate)) return candidate.toLowerCase();

  const rgb = RGB_COLOR.exec(candidate);
  if (rgb !== null) {
    const [, red, green, blue, alpha] = rgb;
    if (red === undefined || green === undefined || blue === undefined) return undefined;
    if (
      parseChannel(red, 255) &&
      parseChannel(green, 255) &&
      parseChannel(blue, 255) &&
      parseAlpha(alpha)
    ) {
      return candidate;
    }
    return undefined;
  }

  const hsl = HSL_COLOR.exec(candidate);
  if (hsl !== null) {
    const [, hue, saturation, lightness, alpha] = hsl;
    if (hue === undefined || saturation === undefined || lightness === undefined) return undefined;
    const s = numeric(saturation);
    const l = numeric(lightness);
    if (parseHue(hue) && s >= 0 && s <= 100 && l >= 0 && l <= 100 && parseAlpha(alpha)) {
      return candidate;
    }
    return undefined;
  }

  const oklch = OKLCH_COLOR.exec(candidate);
  if (oklch !== null) {
    const [, lightness, chroma, hue, alpha] = oklch;
    if (lightness === undefined || chroma === undefined || hue === undefined) return undefined;
    const l = numeric(lightness);
    const c = numeric(chroma);
    const h = numeric(hue);
    const lMax = lightness.endsWith('%') ? 100 : 1;
    const cMax = chroma.endsWith('%') ? 100 : 1;
    if (l >= 0 && l <= lMax && c >= 0 && c <= cMax && h >= 0 && h <= 360 && parseAlpha(alpha)) {
      return candidate;
    }
    return undefined;
  }

  return undefined;
}

/** Accepts a single non-negative CSS length (`0`, `8px`, `0.625rem`, `50%`). */
export function sanitizeIdpnRadius(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = normalize(value);
  if (candidate.length > MAX_RADIUS_LENGTH || !RADIUS.test(candidate)) return undefined;
  return candidate;
}

/** Maps a branding font family to one of the fixed, allowlisted stacks. */
export function sanitizeIdpnFont(value: unknown): IdpnThemeFont | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value
    .trim()
    .toLowerCase()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+/g, ' ');
  if (candidate.length === 0 || candidate.length > MAX_FONT_LENGTH) return undefined;
  return FONT_ALIASES[candidate];
}

const sanitizeColors = (input: unknown): IdpnThemeColors => {
  if (!isRecord(input)) return {};
  const colors: IdpnThemeColors = {};
  for (const key of IDPN_THEME_COLOR_KEYS) {
    const color = sanitizeIdpnColor(input[key]);
    if (color !== undefined) {
      colors[key] = color;
    }
  }
  return colors;
};

const sanitizeFontFamily = (input: unknown): IdpnThemeFontFamily => {
  if (!isRecord(input)) return {};
  const family: IdpnThemeFontFamily = {};
  const rtl = sanitizeIdpnFont(input.rtl);
  const ltr = sanitizeIdpnFont(input.ltr);
  if (rtl !== undefined) family.rtl = rtl;
  if (ltr !== undefined) family.ltr = ltr;
  return family;
};

/**
 * Field-level sanitizer for client branding. Invalid values and unknown keys are dropped,
 * so the caller can always fall back to the stylesheet defaults. Never throws.
 */
export function sanitizeIdpnTheme(input: unknown): IdpnTheme {
  if (!isRecord(input)) return {};

  const theme: IdpnTheme = { ...sanitizeColors(input) };
  const radius = sanitizeIdpnRadius(input.radius);
  if (radius !== undefined) theme.radius = radius;

  const family = sanitizeFontFamily(input.fontFamily);
  if (Object.keys(family).length > 0) theme.fontFamily = family;

  const dark = sanitizeColors(input.dark);
  if (Object.keys(dark).length > 0) theme.dark = dark;

  return theme;
}

/** Locale-driven default stack (docs/localization.md 2, docs/design-system.md 8). */
function defaultFontForLocale(locale: string | undefined): IdpnThemeFont | undefined {
  if (locale === undefined) {
    return undefined;
  }
  const language = locale.trim().toLowerCase().split('-')[0] ?? '';
  return language === 'fa' || language === 'ar' || language === 'he' || language === 'ur'
    ? 'vazirmatn'
    : 'inter';
}

/**
 * Maps a sanitized theme to `--idpn-*` custom properties. The function sanitizes again so
 * an untrusted object can be passed safely. Semantic shadcn variables (`--primary`, …) are
 * assigned from these properties in `web/src/styles/globals.css`, scoped to `.idpn-root`.
 *
 * The active stack follows the resolved locale (`fa-IR` -> Vazirmatn, `en-US` -> Inter)
 * unless the client explicitly overrides the stack for that direction. Only allowlisted
 * constant stacks are ever emitted, never a font URL.
 */
export function idpnThemeToCssVariables(
  input: unknown,
  options: { dir?: 'rtl' | 'ltr'; locale?: string } = {},
): Record<string, string> {
  const theme = sanitizeIdpnTheme(input);
  const variables: Record<string, string> = {};

  for (const key of IDPN_THEME_COLOR_KEYS) {
    const value = theme[key];
    if (value !== undefined) {
      variables[`--idpn-${COLOR_VARIABLE_SUFFIX[key]}`] = value;
    }
  }

  if (theme.radius !== undefined) {
    variables['--idpn-radius'] = theme.radius;
  }

  const rtl = theme.fontFamily?.rtl ?? IDPN_DEFAULT_FONTS.rtl;
  const ltr = theme.fontFamily?.ltr ?? IDPN_DEFAULT_FONTS.ltr;
  const direction = options.dir === 'ltr' ? 'ltr' : 'rtl';
  const active =
    theme.fontFamily?.[direction] ??
    defaultFontForLocale(options.locale) ??
    IDPN_DEFAULT_FONTS[direction];
  variables['--idpn-font-rtl'] = IDPN_THEME_FONT_STACKS[rtl];
  variables['--idpn-font-ltr'] = IDPN_THEME_FONT_STACKS[ltr];
  variables['--idpn-font-sans'] = IDPN_THEME_FONT_STACKS[active];

  if (theme.dark !== undefined) {
    for (const key of IDPN_THEME_COLOR_KEYS) {
      const value = theme.dark[key];
      if (value !== undefined) {
        variables[`--idpn-dark-${COLOR_VARIABLE_SUFFIX[key]}`] = value;
      }
    }
  }

  return variables;
}

const colorSchema = z
  .string()
  .max(MAX_COLOR_LENGTH)
  .refine((value) => sanitizeIdpnColor(value) !== undefined, 'Invalid CSS color value');

const colorFields = {
  background: colorSchema.optional(),
  foreground: colorSchema.optional(),
  card: colorSchema.optional(),
  primary: colorSchema.optional(),
  primaryForeground: colorSchema.optional(),
  secondary: colorSchema.optional(),
  muted: colorSchema.optional(),
  accent: colorSchema.optional(),
  destructive: colorSchema.optional(),
  border: colorSchema.optional(),
  input: colorSchema.optional(),
  ring: colorSchema.optional(),
} as const;

const fontSchema = z.enum(IDPN_THEME_FONT_KEYS);

/**
 * Public theme payload. Unknown fields are stripped (a client may store extra branding in
 * its row), values must already be canonical — `sanitizeIdpnTheme` is the input boundary.
 */
export const idpnThemeSchema = z.object({
  ...colorFields,
  radius: z
    .string()
    .max(MAX_RADIUS_LENGTH)
    .refine((value) => sanitizeIdpnRadius(value) !== undefined, 'Invalid CSS radius value')
    .optional(),
  fontFamily: z
    .object({
      rtl: fontSchema.optional(),
      ltr: fontSchema.optional(),
    })
    .optional(),
  dark: z.object(colorFields).optional(),
});
