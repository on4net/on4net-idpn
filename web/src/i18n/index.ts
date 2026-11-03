/**
 * UI-facing entry point of the shared base bundles (`@idpn/i18n`).
 *
 * The only web-specific behaviour is the production flag: a missing key must never be
 * rendered as raw key text in a built bundle, while tests and development keep the key so
 * the gap is visible.
 */
import {
  translate as translateMessage,
  type Locale,
  type MessageBundle,
  type MessageValues,
} from '@idpn/i18n';

export {
  BASE_LOCALES as SUPPORTED_LOCALES,
  createTranslator,
  directionOf,
  formatCurrency,
  formatDate,
  formatNumber,
  isDirection,
  isLocaleCode,
  matchLocale,
  MESSAGES,
  normalizeLocale,
  parseAcceptLanguage,
  resolveDirection,
  resolveLocale,
} from '@idpn/i18n';
export type { Direction, Locale, LocaleSources, MessageBundle } from '@idpn/i18n';

/**
 * Translates a key with the production guard used by every shipped surface.
 *
 * `messages` is the validated player translation bundle for one locale (base bundle +
 * per-client overrides). When omitted, the shared base bundle is used.
 */
export function translate(
  locale: Locale,
  key: string,
  values: MessageValues = {},
  messages?: Partial<Record<string, MessageBundle>>,
): string {
  return translateMessage(locale, key, values, {
    production: import.meta.env.MODE === 'production',
    ...(messages === undefined ? {} : { messages }),
  });
}

export const DEFAULT_LOCALE: Locale = 'fa-IR';
export type { MessageValues };
