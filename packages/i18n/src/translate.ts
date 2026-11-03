/**
 * Message lookup and formatting (docs/localization.md 4 and 5).
 *
 * Lookup chain: current locale bundle -> default locale bundle -> safe fallback. In
 * development and tests the key itself is returned so a missing translation is visible;
 * in production the raw key is never rendered (it can leak internal names and breaks the
 * screen for users), a neutral ellipsis is used instead.
 */
import { type Locale } from './locale.js';
import { bundleOf, MESSAGES, type MessageBundle } from './messages.js';

/** Rendered instead of an unknown key in a production build. */
export const SAFE_FALLBACK = '…';

export type MessageValues = Readonly<Record<string, string | number>>;

export interface TranslateOptions {
  /** Locale used when the current bundle has no entry; `fa-IR` by default. */
  defaultLocale?: Locale;
  /** Per-client overrides (docs/localization.md 4); not used by the base UI yet. */
  messages?: Partial<Record<string, MessageBundle>>;
  /** When true, an unknown key renders {@link SAFE_FALLBACK} instead of the key. */
  production?: boolean;
}

type PluralCategory = Intl.LDMLPluralRule | 'other';

function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** Parses `one {…} other {…}` (and `=0 {…}`) into a category -> template map. */
function parseOptions(text: string): Record<string, string> {
  const options: Record<string, string> = {};
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index] ?? '')) {
      index += 1;
    }
    const tokenStart = index;
    while (index < text.length && !/[\s{]/.test(text[index] ?? '')) {
      index += 1;
    }
    const token = text.slice(tokenStart, index);
    while (index < text.length && /\s/.test(text[index] ?? '')) {
      index += 1;
    }
    if (token === '' || text[index] !== '{') {
      break;
    }
    const end = findMatchingBrace(text, index);
    if (end === -1) {
      break;
    }
    options[token] = text.slice(index + 1, end);
    index = end + 1;
  }
  return options;
}

function pluralCategory(locale: string, value: number): PluralCategory {
  try {
    return new Intl.PluralRules(locale).select(value);
  } catch {
    return 'other';
  }
}

function formatNumber(locale: string, value: number): string {
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}

function selectOption(
  options: Record<string, string>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = options[key];
    if (value !== undefined) {
      return value;
    }
  }
  return options['other'];
}

function formatPlaceholder(body: string, values: MessageValues, locale: string): string {
  const complex = /^\s*([A-Za-z0-9_]+)\s*,\s*(plural|select)\s*,([\s\S]*)$/.exec(body);
  if (complex !== null) {
    const [, name = '', kind, rest = ''] = complex;
    const options = parseOptions(rest);
    if (kind === 'plural') {
      const numeric = Number(values[name] ?? 0);
      const value = Number.isFinite(numeric) ? numeric : 0;
      const selected = selectOption(options, [`=${value}`, pluralCategory(locale, value)]) ?? '';
      return formatMessage(selected.replace(/#/g, formatNumber(locale, value)), values, locale);
    }
    const selected = selectOption(options, [String(values[name] ?? 'other')]) ?? '';
    return formatMessage(selected, values, locale);
  }

  const name = body.trim();
  const value = values[name];
  return value === undefined ? `{${name}}` : String(value);
}

/**
 * Formats an ICU-style message: `{name}` placeholders, `{count, plural, one {…} other {…}}`
 * and `{value, select, …}`. Unbalanced braces are rendered literally instead of throwing.
 */
export function formatMessage(template: string, values: MessageValues, locale: string): string {
  let result = '';
  let index = 0;
  while (index < template.length) {
    const open = template.indexOf('{', index);
    if (open === -1) {
      result += template.slice(index);
      break;
    }
    result += template.slice(index, open);
    const close = findMatchingBrace(template, open);
    if (close === -1) {
      result += template.slice(open);
      break;
    }
    result += formatPlaceholder(template.slice(open + 1, close), values, locale);
    index = close + 1;
  }
  return result;
}

function templateOf(locale: string, key: string, options: TranslateOptions): string | undefined {
  // Per-client override -> base bundle of the active locale -> default-locale bundle ->
  // key fallback (docs/localization.md 4). Checking the base bundle between the override
  // and the default locale matters when `messages` carries only the overridden keys.
  const currentOverride = options.messages?.[locale]?.[key];
  if (currentOverride !== undefined) {
    return currentOverride;
  }
  const currentBase = bundleOf(locale)?.[key];
  if (currentBase !== undefined) {
    return currentBase;
  }
  const fallbackLocale = options.defaultLocale ?? 'fa-IR';
  return options.messages?.[fallbackLocale]?.[key] ?? MESSAGES[fallbackLocale]?.[key];
}

/**
 * Translates `key` for `locale` and interpolates `values`.
 *
 * Unknown keys never throw. They render the key in development/tests and
 * {@link SAFE_FALLBACK} in production.
 */
export function translate(
  locale: string,
  key: string,
  values: MessageValues = {},
  options: TranslateOptions = {},
): string {
  const template = templateOf(locale, key, options);
  if (template === undefined) {
    return options.production === true ? SAFE_FALLBACK : key;
  }
  return formatMessage(template, values, locale);
}

/** Builds a bound translator for a screen or module. */
export function createTranslator(
  locale: string,
  options: TranslateOptions = {},
): (key: string, values?: MessageValues) => string {
  return (key, values = {}) => translate(locale, key, values, options);
}
