import { bundleOf } from '@idpn/i18n';
import { directionOf } from '@idpn/i18n/locale';

import { isSafeStoredMessage } from '../admin/translations/translation-validation.js';
import type { Calendar, LocaleSettings } from './locale-settings.js';

export interface TranslationBundle {
  locale: string;
  dir: 'rtl' | 'ltr';
  calendar: Calendar;
  version: string;
  messages: Record<string, string>;
}

/**
 * Merges the shared base bundle with the client's overrides (docs/localization.md 4 and
 * 6.2). Only base keys are ever returned; a stored value that fails the plain-text rules
 * (for example one written before validation existed) is ignored in favour of the base text.
 */
export function buildTranslationBundle(input: {
  locale: string;
  settings: LocaleSettings;
  overrides: Record<string, string>;
}): TranslationBundle | null {
  const base = bundleOf(input.locale);
  if (base === undefined) {
    return null;
  }

  const messages: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(input.overrides)) {
    if (key in base && isSafeStoredMessage(value)) {
      messages[key] = value;
    }
  }

  return {
    locale: input.locale,
    dir: input.settings.dir[input.locale] ?? directionOf(input.locale),
    calendar: input.settings.calendar,
    version: input.settings.version,
    messages,
  };
}
