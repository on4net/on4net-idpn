/**
 * UI-facing entry point of the shared base bundles (`@idpn/i18n`).
 *
 * The only web-specific behaviour is the production flag: a missing key must never be
 * rendered as raw key text in a built bundle, while tests and development keep the key so
 * the gap is visible.
 */
import { translate as translateMessage, type Locale, type MessageValues } from '@idpn/i18n';

export {
  BASE_LOCALES as SUPPORTED_LOCALES,
  createTranslator,
  directionOf,
  isDirection,
  isLocaleCode,
  matchLocale,
  MESSAGES,
  normalizeLocale,
  parseAcceptLanguage,
  resolveDirection,
  resolveLocale,
} from '@idpn/i18n';
export type { Direction, Locale, LocaleSources } from '@idpn/i18n';

export function translate(locale: Locale, key: string, values: MessageValues = {}): string {
  return translateMessage(locale, key, values, {
    production: import.meta.env.MODE === 'production',
  });
}

export const DEFAULT_LOCALE: Locale = 'fa-IR';
export type { MessageValues };
