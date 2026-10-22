import { MESSAGES } from '@idpn/i18n';
import { isLocaleCode, normalizeLocale } from '@idpn/i18n/locale';

import {
  CALENDARS,
  MAX_LOCALE_LENGTH,
  MAX_SUPPORTED_LOCALES,
  type Calendar,
} from '../../translations/locale-settings.js';

/**
 * Validation for per-client translation administration (docs/api.md 3.3.4,
 * docs/localization.md 4, 7 and 12).
 *
 * The base bundle in `packages/i18n/messages` is the source of truth: an app may only
 * override existing keys, and it may only use placeholders that the base message already
 * defines (plus the documented `{name}`, `{appName}` and `{supportEmail}`).
 */
export const MAX_MESSAGE_LENGTH = 500;
export const MAX_MESSAGES_PER_REQUEST = 500;

const BASE_BUNDLE = MESSAGES['fa-IR'];
export const BASE_MESSAGE_KEYS: ReadonlySet<string> = new Set(Object.keys(BASE_BUNDLE));

/** Placeholders explicitly allowed by docs/localization.md 4, in addition to the base text. */
const DOCUMENTED_PLACEHOLDERS = new Set(['name', 'appName', 'supportEmail']);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Extracts ICU/`{placeholder}` names from a message. */
export function placeholderNames(value: string): Set<string> {
  const names = new Set<string>();
  const pattern = /\{\s*([A-Za-z][A-Za-z0-9_]*)\s*[,}]/g;
  for (const match of value.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
}

/** Rejects C0 control characters (except tab/newline/CR) and DEL. */
export function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      return true;
    }
  }
  return false;
}

/** True when every `{` has a matching `}` in order (ICU plural/select blocks included). */
export function bracesBalanced(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

export interface LocaleSettingsValidationInput {
  default: string;
  supported: readonly string[];
  calendar?: string | undefined;
}

/**
 * Validates the `PUT /locales` payload. Returns every problem (never throws) so the route
 * can report them in one `422`.
 */
export function localeSettingsProblems(input: LocaleSettingsValidationInput): string[] {
  const problems: string[] = [];

  if (!isLocaleCode(input.default) || normalizeLocale(input.default) === undefined) {
    problems.push('default: must be a BCP-47 locale code');
  }
  if (input.supported.length === 0) {
    problems.push('supported: at least one locale is required');
  }
  if (input.supported.length > MAX_SUPPORTED_LOCALES) {
    problems.push(`supported: at most ${MAX_SUPPORTED_LOCALES} locales are allowed`);
  }

  const seen = new Set<string>();
  input.supported.forEach((locale, index) => {
    if (locale.length > MAX_LOCALE_LENGTH) {
      problems.push(`supported[${index}]: must be at most ${MAX_LOCALE_LENGTH} characters`);
    }
    if (!isLocaleCode(locale) || normalizeLocale(locale) === undefined) {
      problems.push(`supported[${index}]: must be a BCP-47 locale code`);
      return;
    }
    const normalized = normalizeLocale(locale) ?? locale;
    const folded = normalized.toLowerCase();
    if (seen.has(folded)) {
      problems.push(`supported[${index}]: duplicate locale ${normalized}`);
    }
    seen.add(folded);
  });

  const normalizedDefault = normalizeLocale(input.default);
  if (
    normalizedDefault !== undefined &&
    input.supported.length > 0 &&
    !input.supported.some(
      (locale) => normalizeLocale(locale)?.toLowerCase() === normalizedDefault.toLowerCase(),
    )
  ) {
    problems.push('default: must be one of the supported locales');
  }

  if (input.calendar !== undefined && !(CALENDARS as readonly string[]).includes(input.calendar)) {
    problems.push(`calendar: must be one of ${CALENDARS.join(', ')}`);
  }

  return problems;
}

export interface MessageValidationResult {
  problems: string[];
  unknownKeys: string[];
  /** Known keys with a non-empty plain-text value, ready to persist. */
  messages: Record<string, string>;
  /** Known keys mapped to an empty value; the route deletes them to restore the base text. */
  deletions: string[];
}

/**
 * Validates `PUT /translations/{locale}`. Unknown keys are reported separately so the
 * route can name every rejected key. Empty values are deletions by contract.
 */
export function validateMessages(input: unknown): MessageValidationResult {
  if (!isPlainObject(input)) {
    return {
      problems: ['messages: must be an object'],
      unknownKeys: [],
      messages: {},
      deletions: [],
    };
  }

  const entries = Object.entries(input);
  const problems: string[] = [];
  if (entries.length === 0) {
    problems.push('messages: at least one message is required');
  }
  if (entries.length > MAX_MESSAGES_PER_REQUEST) {
    problems.push(`messages: at most ${MAX_MESSAGES_PER_REQUEST} keys are allowed`);
  }

  const unknownKeys = entries
    .map(([key]) => key)
    .filter((key) => !BASE_MESSAGE_KEYS.has(key))
    .sort();
  if (unknownKeys.length > 0) {
    problems.push(`unknown translation key(s): ${unknownKeys.join(', ')}`);
  }

  const messages: Record<string, string> = {};
  const deletions: string[] = [];

  for (const [key, value] of entries) {
    if (!BASE_MESSAGE_KEYS.has(key)) {
      continue;
    }
    if (typeof value !== 'string') {
      problems.push(`${key}: must be a string`);
      continue;
    }
    if (value.trim() === '') {
      deletions.push(key);
      continue;
    }
    if (value.length > MAX_MESSAGE_LENGTH) {
      problems.push(`${key}: must be at most ${MAX_MESSAGE_LENGTH} characters`);
      continue;
    }
    // Markup is never accepted: docs/localization.md 12 requires rendering as data, and
    // rejecting it here keeps the public bundle safe even for a non-React consumer.
    if (/[<>]/.test(value)) {
      problems.push(`${key}: must be plain text (no HTML or script)`);
      continue;
    }
    if (hasControlCharacters(value)) {
      problems.push(`${key}: contains control characters`);
      continue;
    }
    if (!bracesBalanced(value)) {
      problems.push(`${key}: has unbalanced placeholders`);
      continue;
    }

    const baseValue = BASE_BUNDLE[key as keyof typeof BASE_BUNDLE] ?? '';
    const allowed = new Set([...placeholderNames(baseValue), ...DOCUMENTED_PLACEHOLDERS]);
    const invalid = [...placeholderNames(value)].filter((name) => !allowed.has(name));
    if (invalid.length > 0) {
      problems.push(`${key}: placeholder(s) not allowed: ${invalid.sort().join(', ')}`);
      continue;
    }

    messages[key] = value;
  }

  return { problems, unknownKeys, messages, deletions };
}

/** Rejects a stored value that would render markup or exceed the documented limit. */
export function isSafeStoredMessage(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_MESSAGE_LENGTH &&
    !/[<>]/.test(value) &&
    !hasControlCharacters(value) &&
    bracesBalanced(value)
  );
}

export type { Calendar };
