import * as React from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { directionOf, type Locale } from '@/i18n';
import { useTranslate } from '@/i18n/translation-context';

export interface LanguageSwitcherProps {
  locale: Locale;
  /** Enabled locales with a shipped base bundle; at least two entries are required. */
  locales: readonly Locale[];
  /**
   * Direction resolved by the page (config `locales.dir` may override the language default),
   * so the control aligns with the card instead of guessing from the locale (card #60).
   */
  dir?: 'rtl' | 'ltr';
  onChange(next: Locale): void;
}

/**
 * Language control of the Hosted Auth UI. It only offers locales enabled by the client
 * and shipped in the base package; an unsupported value can never be selected. The
 * control is rendered outside the form card so visual baselines of the form stay stable.
 */
export function LanguageSwitcher({
  locale,
  locales,
  dir,
  onChange,
}: LanguageSwitcherProps): React.ReactElement | null {
  const t = useTranslate(locale);
  if (locales.length < 2) {
    return null;
  }

  return (
    <div className="mb-3 flex justify-end" dir={dir ?? directionOf(locale)}>
      <Select
        value={locale}
        onValueChange={(next) => {
          if (locales.includes(next as Locale)) {
            onChange(next as Locale);
          }
        }}
      >
        <SelectTrigger
          className="h-8 w-auto min-w-32 px-3 text-sm"
          aria-label={t('language.label')}
          data-testid="language-switcher"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {locales.map((entry) => (
            <SelectItem key={entry} value={entry}>
              {t(`language.option.${entry}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
