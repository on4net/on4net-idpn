import {
  directionOf,
  isDirection,
  isLocaleCode,
  normalizeLocale,
  type Direction,
} from '@idpn/i18n/locale';

/**
 * Per-client locale settings stored in `clients.locales` (docs/localization.md 6.1 and 9).
 *
 * The JSON column may predate validation, so every read normalizes it: invalid locales are
 * dropped, the default always belongs to `supported`, and a direction is derived when the
 * stored override is not `rtl`/`ltr`.
 */
export const CALENDARS = ['gregorian', 'persian'] as const;
export type Calendar = (typeof CALENDARS)[number];

export const DEFAULT_LOCALE = 'fa-IR';
export const MAX_SUPPORTED_LOCALES = 20;
export const MAX_LOCALE_LENGTH = 35;

export interface LocaleSettings {
  default: string;
  supported: string[];
  dir: Record<string, Direction>;
  calendar: Calendar;
  /** Cache/ETag basis; bumped on every accepted write. */
  version: string;
}

export function isCalendar(value: unknown): value is Calendar {
  return typeof value === 'string' && (CALENDARS as readonly string[]).includes(value);
}

/** Persian is the documented default for Persian locales, Gregorian otherwise. */
export function defaultCalendarFor(locale: string): Calendar {
  const language = (normalizeLocale(locale) ?? locale).split('-')[0]?.toLowerCase();
  return language === 'fa' || language === 'ar' ? 'persian' : 'gregorian';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Normalizes supported locales, preserving order and folding case-insensitive duplicates. */
export function normalizeSupportedLocales(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const supported: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = normalizeLocale(value);
    if (
      normalized === undefined ||
      !isLocaleCode(normalized) ||
      supported.some((locale) => locale.toLowerCase() === normalized.toLowerCase())
    ) {
      continue;
    }
    supported.push(normalized);
  }
  return supported;
}

/**
 * Reads the stored `clients.locales` JSON. A client without settings behaves like the
 * documented Persian default; a default outside `supported` falls back to the first entry.
 */
export function normalizeLocaleSettings(
  raw: unknown,
  options: { fallbackVersion?: string } = {},
): LocaleSettings {
  const value = isRecord(raw) ? raw : {};
  const supported = normalizeSupportedLocales(value['supported']);
  if (supported.length === 0) {
    supported.push(DEFAULT_LOCALE);
  }

  const requestedDefault = normalizeLocale(
    typeof value['default'] === 'string' ? value['default'] : undefined,
  );
  const defaultLocale =
    supported.find((locale) => locale.toLowerCase() === requestedDefault?.toLowerCase()) ??
    supported[0] ??
    DEFAULT_LOCALE;

  const rawDir = isRecord(value['dir']) ? value['dir'] : {};
  const dir: Record<string, Direction> = {};
  for (const locale of supported) {
    const overrideKey = Object.keys(rawDir).find(
      (candidate) => candidate.toLowerCase() === locale.toLowerCase(),
    );
    const override = overrideKey === undefined ? undefined : rawDir[overrideKey];
    dir[locale] = isDirection(override) ? override : directionOf(locale);
  }

  const calendar = isCalendar(value['calendar'])
    ? value['calendar']
    : defaultCalendarFor(defaultLocale);
  const version =
    typeof value['version'] === 'string' && value['version'] !== ''
      ? value['version']
      : (options.fallbackVersion ?? new Date(0).toISOString());

  return { default: defaultLocale, supported, dir, calendar, version };
}

/** Builds the persisted shape from already-validated input. */
export function localeSettingsFromInput(
  input: { default: string; supported: readonly string[]; calendar: Calendar },
  version: string,
): LocaleSettings {
  const supported = normalizeSupportedLocales(input.supported);
  const defaultLocale =
    supported.find((locale) => locale.toLowerCase() === input.default.toLowerCase()) ??
    supported[0] ??
    DEFAULT_LOCALE;
  const dir: Record<string, Direction> = {};
  for (const locale of supported) {
    dir[locale] = directionOf(locale);
  }
  return {
    default: defaultLocale,
    supported,
    dir,
    calendar: input.calendar,
    version,
  };
}
