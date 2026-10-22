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

interface Rgb {
  /** sRGB channels in 0..1. */
  r: number;
  g: number;
  b: number;
  /** Opacity in 0..1; absent means fully opaque. */
  a?: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** sRGB transfer function (IEC 61966-2-1) to relative luminance. */
const linearize = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

const fromLinear = (channel: number): number =>
  channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;

const hueToRgb = (p: number, q: number, rawT: number): number => {
  let t = rawT;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
};

function hueToRadians(raw: string): number {
  const value = numeric(raw);
  if (raw.endsWith('turn')) return value * 2 * Math.PI;
  if (raw.endsWith('grad')) return (value * Math.PI) / 200;
  if (raw.endsWith('rad')) return value;
  return (value * Math.PI) / 180;
}

/** Channel value as a 0..1 fraction; `%` is interpreted against 255 for rgb channels. */
function rgbChannel(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = numeric(raw);
  if (!Number.isFinite(value)) return null;
  return clamp01(raw.endsWith('%') ? value / 100 : value / 255);
}

/** `rgb(? / 50%)` and `rgba(?, 0.5)` both carry alpha; `#rgba`/`#rrggbbaa` are handled above. */
function alphaChannel(candidate: string): number | undefined {
  const match =
    /\/\s*([0-9.]+)(%?)\s*\)$/.exec(candidate) ?? /,\s*([0-9.]+)(%?)\s*\)$/.exec(candidate);
  if (match === null) {
    return undefined;
  }
  const value = Number.parseFloat(match[1] ?? '');
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return clamp01(match[2] === '%' ? value / 100 : value);
}

/**
 * Resolves a theme colour to sRGB so the contrast guard can measure it.
 * Returns `null` for values whose rendered colour is unknown (`transparent`,
 * `currentcolor`) or out of the supported grammar.
 */
export function resolveThemeColor(value: string): Rgb | null {
  const candidate = typeof value === 'string' ? value.trim() : '';
  const lower = candidate.toLowerCase();
  if (lower === 'white') return { r: 1, g: 1, b: 1 };
  if (lower === 'black') return { r: 0, g: 0, b: 0 };

  const hex = /^#([0-9a-f]{3,8})$/i.exec(candidate);
  if (hex !== null) {
    const digits = hex[1] ?? '';
    const expand = (part: string): number => Number.parseInt(part.repeat(2), 16) / 255;
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: expand(digits[0] ?? ''),
        g: expand(digits[1] ?? ''),
        b: expand(digits[2] ?? ''),
        ...(digits.length === 4
          ? { a: Number.parseInt(`${digits[3] ?? 'f'}${digits[3] ?? 'f'}`, 16) / 255 }
          : {}),
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: Number.parseInt(digits.slice(0, 2), 16) / 255,
        g: Number.parseInt(digits.slice(2, 4), 16) / 255,
        b: Number.parseInt(digits.slice(4, 6), 16) / 255,
        ...(digits.length === 8 ? { a: Number.parseInt(digits.slice(6, 8), 16) / 255 } : {}),
      };
    }
    return null;
  }

  const rgb = RGB_COLOR.exec(candidate);
  if (rgb !== null) {
    const red = rgbChannel(rgb[1]);
    const green = rgbChannel(rgb[2]);
    const blue = rgbChannel(rgb[3]);
    if (red === null || green === null || blue === null) return null;
    const alpha = alphaChannel(candidate);
    return { r: red, g: green, b: blue, ...(alpha === undefined ? {} : { a: alpha }) };
  }

  const hsl = HSL_COLOR.exec(candidate);
  if (hsl !== null) {
    const hue = greyHue(hsl[1]);
    const saturation = Math.min(1, Math.max(0, numeric(hsl[2] ?? '0') / 100));
    const lightness = Math.min(1, Math.max(0, numeric(hsl[3] ?? '0') / 100));
    const alpha = alphaChannel(candidate);
    if (hue === null || saturation === 0) {
      return {
        r: lightness,
        g: lightness,
        b: lightness,
        ...(alpha === undefined ? {} : { a: alpha }),
      };
    }
    const q =
      lightness < 0.5
        ? lightness * (1 + saturation)
        : lightness + saturation - lightness * saturation;
    const p = 2 * lightness - q;
    const hueTurn = hue / (2 * Math.PI);
    return {
      r: hueToRgb(p, q, hueTurn + 1 / 3),
      g: hueToRgb(p, q, hueTurn),
      b: hueToRgb(p, q, hueTurn - 1 / 3),
      ...(alpha === undefined ? {} : { a: alpha }),
    };
  }

  const oklch = OKLCH_COLOR.exec(candidate);
  if (oklch !== null) {
    const rawLightness = oklch[1] ?? '';
    const rawChroma = oklch[2] ?? '';
    const lightness = rawLightness.endsWith('%')
      ? numeric(rawLightness) / 100
      : numeric(rawLightness);
    const chroma = rawChroma.endsWith('%') ? numeric(rawChroma) / 100 : numeric(rawChroma);
    const hue = hueToRadians(oklch[3] ?? '0');
    // OKLab -> linear sRGB (Björn Ottosson's matrices), then gamma encode.
    const a = chroma * Math.cos(hue);
    const b = chroma * Math.sin(hue);
    const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
    const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
    const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
    const l = lPrime ** 3;
    const m = mPrime ** 3;
    const s = sPrime ** 3;
    const alpha = alphaChannel(candidate);
    return {
      r: clamp01(fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
      g: clamp01(fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
      b: clamp01(fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
      ...(alpha === undefined ? {} : { a: alpha }),
    };
  }

  return null;
}

function greyHue(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = hueToRadians(raw);
  return Number.isFinite(value) ? value : null;
}

/** WCAG 2.x relative luminance of an sRGB colour. */
export function relativeLuminance(color: Rgb): number {
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

/**
 * WCAG contrast ratio between two theme colours, or `null` when either value cannot be
 * measured (`transparent`, `currentcolor`, an unknown colour space).
 */
export function contrastRatio(foreground: string, background: string): number | null {
  const front = resolveThemeColor(foreground);
  const back = resolveThemeColor(background);
  if (front === null || back === null) {
    return null;
  }
  // A translucent background has no measurable colour of its own; treating it as opaque was
  // how an almost invisible label could still report a passing ratio (card #53 finding 2).
  if (back.a !== undefined && back.a < 1) {
    return null;
  }
  const painted =
    front.a === undefined || front.a >= 1
      ? front
      : {
          r: front.r * front.a + back.r * (1 - front.a),
          g: front.g * front.a + back.g * (1 - front.a),
          b: front.b * front.a + back.b * (1 - front.a),
        };
  const a = relativeLuminance(painted);
  const b = relativeLuminance(back);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA for normal text (`docs/design-system.md` 4). */
export const MIN_CONTRAST_RATIO = 4.5;

/**
 * Built-in palette (`web/src/styles/globals.css`). Every pair the contrast guard evaluates is
 * mirrored here; `globals.css` remains the source of truth for rendering and a unit test binds
 * the two together so they cannot drift.
 */
export const IDPN_BASE_THEME = {
  light: {
    background: 'oklch(1 0 0)',
    foreground: 'oklch(0.145 0 0)',
    card: 'oklch(1 0 0)',
    cardForeground: 'oklch(0.145 0 0)',
    primary: 'oklch(0.48 0.11 190)',
    primaryForeground: 'oklch(0.99 0 0)',
    secondary: 'oklch(0.97 0 0)',
    secondaryForeground: 'oklch(0.205 0 0)',
    muted: 'oklch(0.97 0 0)',
    mutedForeground: 'oklch(0.52 0 0)',
    accent: 'oklch(0.97 0 0)',
    accentForeground: 'oklch(0.205 0 0)',
  },
  dark: {
    background: 'oklch(0.145 0 0)',
    foreground: 'oklch(0.985 0 0)',
    card: 'oklch(0.205 0 0)',
    cardForeground: 'oklch(0.985 0 0)',
    primary: 'oklch(0.72 0.12 190)',
    primaryForeground: 'oklch(0.205 0 0)',
    secondary: 'oklch(0.269 0 0)',
    secondaryForeground: 'oklch(0.985 0 0)',
    muted: 'oklch(0.269 0 0)',
    mutedForeground: 'oklch(0.708 0 0)',
    accent: 'oklch(0.371 0 0)',
    accentForeground: 'oklch(0.985 0 0)',
  },
} as const;

type ContrastBase = Readonly<Record<keyof (typeof IDPN_BASE_THEME)['light'], string>>;

/**
 * Every text/surface pair the contract exposes. Four of the twelve client keys are surfaces
 * (`card`, `secondary`, `muted`, `accent`) whose foreground is a fixed literal; checking only
 * the two original pairs let a client paint unreadable text on them (card #53 finding 1).
 */
export const IDPN_CONTRAST_PAIRS = [
  ['foreground', 'background'],
  ['primaryForeground', 'primary'],
  ['cardForeground', 'card'],
  ['secondaryForeground', 'secondary'],
  ['mutedForeground', 'muted'],
  ['accentForeground', 'accent'],
] as const;

const CLIENT_COLOR_KEYS = new Set<string>(IDPN_THEME_COLOR_KEYS);

const clientColor = (colors: IdpnThemeColors, key: string): string | undefined =>
  CLIENT_COLOR_KEYS.has(key) ? colors[key as IdpnThemeColorKey] : undefined;

/**
 * Drops a failing colour so the built-in palette applies instead of rendering unreadable
 * text (`docs/design-system.md` 4, card #53). A pair fails when the effective ratio is below
 * {@link MIN_CONTRAST_RATIO}, is unmeasurable (e.g. a translucent background) or unknown;
 * every client-settable member of the pair is removed so the fallback stays coherent.
 */
function enforceContrast(colors: IdpnThemeColors, base: ContrastBase): IdpnThemeColors {
  const result: IdpnThemeColors = { ...colors };
  for (const [foregroundKey, backgroundKey] of IDPN_CONTRAST_PAIRS) {
    const foreground = clientColor(result, foregroundKey) ?? base[foregroundKey];
    const background = clientColor(result, backgroundKey) ?? base[backgroundKey];
    const ratio = contrastRatio(foreground, background);
    if (ratio !== null && ratio >= MIN_CONTRAST_RATIO) {
      continue;
    }
    if (CLIENT_COLOR_KEYS.has(foregroundKey)) {
      delete result[foregroundKey as IdpnThemeColorKey];
    }
    if (CLIENT_COLOR_KEYS.has(backgroundKey)) {
      delete result[backgroundKey as IdpnThemeColorKey];
    }
  }
  return result;
}

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
 * and a colour pair that cannot reach WCAG AA is removed so the caller always falls back to
 * the accessible built-in palette. Never throws.
 */
export function sanitizeIdpnTheme(input: unknown): IdpnTheme {
  if (!isRecord(input)) return {};

  const theme: IdpnTheme = { ...enforceContrast(sanitizeColors(input), IDPN_BASE_THEME.light) };
  const radius = sanitizeIdpnRadius(input.radius);
  if (radius !== undefined) theme.radius = radius;

  const family = sanitizeFontFamily(input.fontFamily);
  if (Object.keys(family).length > 0) theme.fontFamily = family;

  const dark = enforceContrast(sanitizeColors(input.dark), IDPN_BASE_THEME.dark);
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

/**
 * Shape hints emitted into the generated JSON Schema (`contract:check`). They only describe
 * the grammar family; `sanitizeIdpnColor`/`sanitizeIdpnRadius` remain the authoritative
 * validators at runtime.
 */
const COLOR_SHAPE =
  /^(?:#[0-9a-fA-F]{3,8}|[rR][gG][bB][aA]?\(.*\)|[hH][sS][lL][aA]?\(.*\)|[oO][kK][lL][cC][hH]\(.*\)|transparent|black|white|currentcolor)$/;

const colorSchema = z
  .string()
  .max(MAX_COLOR_LENGTH)
  .regex(COLOR_SHAPE, 'Invalid CSS color format')
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
 * Public theme payload. Unknown fields are allowed and stripped by `sanitizeIdpnTheme` (a
 * client may store extra branding in its row); values must already be canonical — the
 * sanitizer is the input boundary.
 */
/**
 * Public theme payload. Unknown fields are allowed and stripped by `sanitizeIdpnTheme` (a
 * client may store extra branding in its row); values must already be canonical — the
 * sanitizer is the input boundary. Kept as a plain (untransformed) schema so the generated
 * JSON artifacts stay representable.
 */
export const idpnThemeSchema = z.looseObject({
  ...colorFields,
  radius: z
    .string()
    .max(MAX_RADIUS_LENGTH)
    .regex(RADIUS, 'Invalid CSS radius format')
    .refine((value) => sanitizeIdpnRadius(value) !== undefined, 'Invalid CSS radius value')
    .optional(),
  fontFamily: z
    .looseObject({
      rtl: fontSchema.optional(),
      ltr: fontSchema.optional(),
    })
    .optional(),
  dark: z.looseObject(colorFields).optional(),
});
