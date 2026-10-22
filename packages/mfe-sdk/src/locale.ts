/**
 * Locale normalization for host configuration.
 *
 * The SDK only ships the two base locales; a host may enable a subset, but it cannot make
 * the SDK emit a locale without a bundle. Invalid values fall back deterministically.
 * Direction is derived from the locale unless the host supplies a validated override.
 */
import type { IdpnDirection, IdpnLocales } from './contract.js';

export const IDPN_BASE_LOCALES = ['fa-IR', 'en-US'] as const;

const LOCALE_CODE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const RTL_LANGUAGES = new Set(['fa', 'ar', 'he', 'ur']);

export function isIdpnLocaleCode(value: unknown): value is string {
  return typeof value === 'string' && LOCALE_CODE.test(value.trim());
}

export function isIdpnDirection(value: unknown): value is IdpnDirection {
  return value === 'rtl' || value === 'ltr';
}

export function idpnDirectionOf(locale: string): IdpnDirection {
  const language = locale.trim().split('-')[0]?.toLowerCase() ?? '';
  return RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
}

function canonical(value: string): string {
  return value
    .trim()
    .split('-')
    .map((part, index) =>
      index === 0 ? part.toLowerCase() : part.length === 2 ? part.toUpperCase() : part,
    )
    .join('-');
}

function match(value: string | undefined, supported: readonly string[]): string | undefined {
  if (value === undefined || !isIdpnLocaleCode(value)) {
    return undefined;
  }
  const normalized = canonical(value);
  return (
    supported.find((locale) => locale.toLowerCase() === normalized.toLowerCase()) ??
    supported.find(
      (locale) => locale.split('-')[0]?.toLowerCase() === normalized.split('-')[0]?.toLowerCase(),
    )
  );
}

/** Locales the SDK can emit, intersected with the host's supported list. */
function enabledLocales(locales: IdpnLocales | undefined): string[] {
  const requested = locales?.supported ?? IDPN_BASE_LOCALES;
  const enabled: string[] = [];
  for (const locale of requested) {
    const found = match(locale, IDPN_BASE_LOCALES);
    if (found !== undefined && !enabled.includes(found)) {
      enabled.push(found);
    }
  }
  return enabled;
}

/**
 * Resolves the module locale: explicit `locale` -> `locales.default` -> `fa-IR`, limited
 * to the enabled base locales.
 */
export function resolveMfeLocale(
  locale: string | undefined,
  locales: IdpnLocales | undefined,
): (typeof IDPN_BASE_LOCALES)[number] {
  const enabled = enabledLocales(locales);
  const candidates = [locale, locales?.default, 'fa-IR'];
  for (const candidate of candidates) {
    const found = match(candidate ?? undefined, enabled);
    if (found !== undefined) {
      return found as (typeof IDPN_BASE_LOCALES)[number];
    }
  }
  // The SDK always ships `fa-IR`, so a client that enables no shipped locale still gets
  // a bundle instead of an undefined locale.
  return 'fa-IR';
}

/** Explicit direction -> per-locale config override -> derived from the locale. */
export function resolveMfeDirection(
  locale: string,
  dir: IdpnDirection | undefined,
  locales: IdpnLocales | undefined,
): IdpnDirection {
  if (isIdpnDirection(dir)) {
    return dir;
  }
  const override = locales?.dir?.[locale];
  return isIdpnDirection(override) ? override : idpnDirectionOf(locale);
}
