/**
 * Locale resolution and direction derivation (docs/localization.md 3).
 *
 * Rules encoded here:
 * - only locales that ship a bundle and are enabled by the client are honoured;
 * - an invalid or unsupported value never throws: it falls through to the next source;
 * - the final fallback is the app default (`fa-IR`);
 * - direction is derived from the resolved locale unless a validated override is supplied.
 */

/** Locales with a base bundle in this package (docs/localization.md 2). */
export const BASE_LOCALES = ['fa-IR', 'en-US'] as const;
export type Locale = (typeof BASE_LOCALES)[number];

export type Direction = 'rtl' | 'ltr';

const DIRECTIONS: readonly Direction[] = ['rtl', 'ltr'];
const RTL_LANGUAGES = new Set(['fa', 'ar', 'he', 'ur']);
const LOCALE_CODE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * BCP-47-shaped language tag accepted by the public config. Full validation/clamping of
 * every regional variant is not the goal; rejecting values that are not tags at all, and
 * values that could smuggle markup into `lang`, is.
 */
export function isLocaleCode(value: unknown): value is string {
  return typeof value === 'string' && LOCALE_CODE.test(value.trim());
}

export function isDirection(value: unknown): value is Direction {
  return value === 'rtl' || value === 'ltr';
}

/** Canonicalizes `en_us` / ` EN-us ` to `en-US`, returning `undefined` for garbage. */
export function normalizeLocale(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const candidate = value.trim().replace(/_/g, '-');
  if (candidate === '' || !LOCALE_CODE.test(candidate)) {
    return undefined;
  }
  return candidate
    .split('-')
    .map((part, index) =>
      index === 0 ? part.toLowerCase() : part.length === 2 ? part.toUpperCase() : part,
    )
    .join('-');
}

/**
 * Direction of a locale. `fa`, `ar`, `he` and `ur` are right-to-left; every other tag is
 * left-to-right (docs/localization.md 2).
 */
export function directionOf(locale: string): Direction {
  const normalized = normalizeLocale(locale) ?? locale;
  const language = normalized.split('-')[0]?.toLowerCase() ?? '';
  return RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
}

/**
 * Direction with an optional override. The override is only honoured when it is exactly
 * `rtl` or `ltr`; callers pass it from the validated public config (`locales.dir`), never
 * from raw user input.
 */
export function resolveDirection(locale: string, override?: unknown): Direction {
  return isDirection(override) ? override : directionOf(locale);
}

/** Parses an `Accept-Language` header into ranges ordered by quality (highest first). */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (typeof header !== 'string' || header.trim() === '') {
    return [];
  }
  const weighted: { range: string; quality: number; index: number }[] = [];
  for (const [index, entry] of header.split(',').entries()) {
    const [rawRange, ...parameters] = entry.split(';');
    const range = rawRange?.trim();
    if (range === undefined || range === '') {
      continue;
    }
    let quality = 1;
    for (const parameter of parameters) {
      const [name, value] = parameter.split('=');
      if (name?.trim().toLowerCase() === 'q') {
        const parsed = Number(value?.trim());
        quality = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    if (quality <= 0) {
      continue;
    }
    weighted.push({ range, quality, index });
  }
  weighted.sort((left, right) => right.quality - left.quality || left.index - right.index);
  return weighted.map((entry) => entry.range);
}

/** Splits `ui_locales` (`fa-IR en-US`, `fa-IR,en-US`) or an array into candidates. */
function localeCandidates(value: string | readonly string[] | null | undefined): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  const entries = typeof value === 'string' ? value.split(/[\s,]+/) : value;
  return entries.map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/**
 * Finds the enabled locale matching a candidate. An exact tag wins; a language-only tag
 * (`en`) matches the first enabled regional variant (`en-US`). Wildcards never match.
 */
export function matchLocale(
  candidate: string | null | undefined,
  supported: readonly string[],
): string | undefined {
  const normalized = normalizeLocale(candidate);
  if (normalized === undefined) {
    return undefined;
  }
  const exact = supported.find((locale) => locale.toLowerCase() === normalized.toLowerCase());
  if (exact !== undefined) {
    return exact;
  }
  const language = normalized.split('-')[0]?.toLowerCase();
  if (language === undefined) {
    return undefined;
  }
  return supported.find((locale) => locale.split('-')[0]?.toLowerCase() === language);
}

export interface LocaleSources {
  /**
   * Explicit host configuration (SDK `locale` prop / per-app locale). It is an explicit
   * choice, evaluated after the request-level `ui_locales` and before browser preferences.
   */
  configLocale?: string | null;
  /** `ui_locales` from `/authorize`; space- or comma-separated. */
  uiLocales?: string | readonly string[] | null;
  /** Raw `Accept-Language` header or `navigator.languages.join(',')`. */
  acceptLanguage?: string | null;
  /** Locale saved for this user and this client (docs/localization.md 3). */
  profileLocale?: string | null;
  /** `locales.default` of the client. */
  clientDefault?: string | null;
  /** `defaultLocale` of the tenant. */
  tenantDefault?: string | null;
  /** Application default; `fa-IR` when omitted. */
  appDefault?: string | null;
  /** Locales enabled by the client. Only these can be returned. */
  supported?: readonly string[] | null;
  /** Locales with a bundle; defaults to {@link BASE_LOCALES}. */
  available?: readonly string[] | null;
}

function enabledLocales(sources: LocaleSources): string[] {
  const available = (sources.available ?? BASE_LOCALES)
    .map((locale) => normalizeLocale(locale))
    .filter((locale): locale is string => locale !== undefined);
  const usable = available.length > 0 ? available : [...BASE_LOCALES];
  const requested = (
    sources.supported === null || sources.supported === undefined ? usable : sources.supported
  )
    .map((locale) => normalizeLocale(locale))
    .filter((locale): locale is string => locale !== undefined);
  const enabled: string[] = [];
  for (const locale of requested) {
    const match = matchLocale(locale, usable);
    if (match !== undefined && !enabled.includes(match)) {
      enabled.push(match);
    }
  }
  return enabled;
}

/**
 * Resolves the UI locale using the documented order (docs/localization.md 3):
 *
 * 1. `ui_locales`, first supported entry wins;
 * 2. explicit host configuration (`configLocale`, SDK/MFE prop);
 * 3. `Accept-Language`, highest quality supported entry;
 * 4. the locale saved in the user profile;
 * 5. the client default;
 * 6. the tenant default;
 * 7. the app default (`fa-IR`).
 *
 * Invalid or unsupported values are skipped, never thrown.
 */
export function resolveLocale(sources: LocaleSources = {}): Locale {
  const enabled = enabledLocales(sources);

  const tiers: (string | null | undefined)[] = [
    ...localeCandidates(sources.uiLocales),
    sources.configLocale,
    ...parseAcceptLanguage(sources.acceptLanguage),
    sources.profileLocale,
    sources.clientDefault,
    sources.tenantDefault,
    sources.appDefault,
    'fa-IR',
  ];

  for (const candidate of tiers) {
    const match = matchLocale(candidate, enabled);
    if (match !== undefined) {
      return match as Locale;
    }
  }

  // No enabled locale matched: use the app default even when the client did not enable
  // it, so the UI never ends up without a bundle.
  return (matchLocale(sources.appDefault ?? 'fa-IR', BASE_LOCALES) ?? 'fa-IR') as Locale;
}

/** `Intl` date/time formatting for the resolved locale. */
export function formatDate(
  locale: string,
  value: Date | number,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  return new Intl.DateTimeFormat(locale, options).format(value);
}

/** `Intl` number formatting for the resolved locale. */
export function formatNumber(
  locale: string,
  value: number,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

/** `Intl` currency formatting for the resolved locale. */
export function formatCurrency(
  locale: string,
  value: number,
  currency: string,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, ...options }).format(value);
}

export { DIRECTIONS };
