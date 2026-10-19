import * as React from 'react';

import type { Locale, MessageBundle } from '@/i18n';
import { translate } from '@/i18n';

export type TranslationOverrides = Partial<Record<string, MessageBundle>>;

interface TranslationScope {
  locale: Locale;
  messages: TranslationOverrides;
}

const TranslationContext = React.createContext<TranslationScope | null>(null);

/**
 * Provides the validated per-client bundle (base bundle + overrides) to every form of the
 * Hosted shell. Components still keep their `locale` prop so they can be rendered
 * standalone in tests and story fixtures; `useTranslate` falls back to the shared bundle
 * when no provider (or a provider for another locale) is present.
 */
export function TranslationProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages?: TranslationOverrides;
  children: React.ReactNode;
}): React.ReactElement {
  const value = React.useMemo<TranslationScope>(
    () => ({ locale, messages: messages ?? {} }),
    [locale, messages],
  );
  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

/** Bound translator for the current component; never renders a client value as HTML. */
export function useTranslate(
  locale: Locale,
): (key: string, values?: Record<string, string | number>) => string {
  const scope = React.useContext(TranslationContext);
  return React.useMemo(
    () =>
      (key: string, values: Record<string, string | number> = {}) =>
        scope !== null && scope.locale === locale
          ? translate(locale, key, values, scope.messages)
          : translate(locale, key, values),
    [locale, scope],
  );
}
