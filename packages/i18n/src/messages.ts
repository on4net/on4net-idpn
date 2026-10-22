/**
 * Typed base bundles (docs/localization.md 4). JSON is the single source of truth for
 * translators; this module adds compile-time key parity between the two locales.
 *
 * `check-messages.mjs` fails the build/test run when a key is missing, duplicated or
 * outside the documented namespaces.
 */
import enUS from '../messages/en-US.json' with { type: 'json' };
import faIR from '../messages/fa-IR.json' with { type: 'json' };

import { BASE_LOCALES, type Locale } from './locale.js';

export type MessageBundle = Readonly<Record<string, string>>;
export type MessageKey = keyof typeof faIR;

/** Compile-time assertion: every key of one bundle exists in the other one. */
type Assert<T extends true> = T;
type SameKeys<Left, Right> = [Exclude<keyof Right, keyof Left>, Exclude<keyof Left, keyof Right>];
export type BundleKeyParity = Assert<
  SameKeys<typeof faIR, typeof enUS> extends [never, never] ? true : false
>;

export const MESSAGES: Record<Locale, MessageBundle> = {
  'fa-IR': faIR,
  'en-US': enUS,
};

export function isBaseLocale(value: string): value is Locale {
  return (BASE_LOCALES as readonly string[]).includes(value);
}

/** Bundle of a locale, or `undefined` when there is no base bundle yet. */
export function bundleOf(locale: string): MessageBundle | undefined {
  return isBaseLocale(locale) ? MESSAGES[locale] : undefined;
}
