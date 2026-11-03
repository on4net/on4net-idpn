import { BASE_LOCALES, bundleOf, matchLocale, normalizeLocale, type Locale } from '@idpn/i18n';
import type { MessageBundle } from '@idpn/i18n';

/** Hard limits mirroring the admin validation; the bundle is public but still input. */
const MAX_MESSAGE_KEYS = 500;
const MAX_MESSAGE_LENGTH = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      return true;
    }
  }
  return false;
}

function bracesBalanced(value: string): boolean {
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

/**
 * Mirrors `isSafeStoredMessage` on the API side: markup, control characters and broken
 * ICU/placeholder syntax are dropped in favour of the shared base text.
 */
export function isSafeClientMessage(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_MESSAGE_LENGTH &&
    !/[<>]/.test(value) &&
    !hasControlCharacters(value) &&
    bracesBalanced(value)
  );
}

/**
 * Builds the renderable bundle for one locale from `GET …/translations/bundle`
 * (docs/localization.md 6.2, docs/api.md 3.3.4).
 *
 * The server already merges base + overrides, but the browser re-checks because the
 * response is network input: only keys of the shared base bundle survive, values must be
 * plain strings of bounded length, and the shared base always fills any missing key. A
 * malformed bundle therefore degrades to the base bundle instead of breaking the form.
 */
export function sanitizeClientBundle(input: unknown, locale: Locale): MessageBundle | null {
  const base = bundleOf(locale);
  if (base === undefined || !isRecord(input)) {
    return null;
  }
  const raw = input.messages;
  if (!isRecord(raw)) {
    return null;
  }

  const messages: Record<string, string> = {};
  let accepted = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (accepted >= MAX_MESSAGE_KEYS) {
      break;
    }
    if (!Object.prototype.hasOwnProperty.call(base, key) || typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    // An empty override is the documented "remove override" signal, so base wins.
    if (!isSafeClientMessage(trimmed)) {
      continue;
    }
    messages[key] = trimmed;
    accepted += 1;
  }

  return { ...base, ...messages };
}

/** Canonical same-origin bundle endpoint; used when the config value is absent/unsafe. */
function canonicalBundlePath(clientId: string): string {
  return `/api/v1/clients/${encodeURIComponent(clientId)}/translations/bundle`;
}

/**
 * Resolves the bundle URL. Only a same-origin `translationsUrl` is honoured; an absolute
 * value on another origin would turn a config typo into a cross-origin request, so it
 * falls back to the canonical IdP path. The locale is always an allowlisted tag produced
 * by `resolveLocale`, never a raw query value.
 */
export function resolveBundleUrl(
  input: { clientId: string; locale: Locale; translationsUrl?: string },
  origin: string = typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
): string {
  const fallback = `${canonicalBundlePath(input.clientId)}?locale=${encodeURIComponent(input.locale)}`;
  if (input.translationsUrl === undefined || input.translationsUrl.trim() === '') {
    return fallback;
  }
  try {
    const candidate = new URL(input.translationsUrl, origin);
    if (candidate.origin !== origin) {
      return fallback;
    }
    candidate.searchParams.set('locale', input.locale);
    return `${candidate.pathname}${candidate.search}`;
  } catch {
    return fallback;
  }
}

export interface ClientBundleInput {
  clientId: string;
  locale: Locale;
  translationsUrl?: string;
  signal?: AbortSignal | undefined;
}

/** Fetches the raw, untrusted bundle body; throws on transport/HTTP failure. */
export async function fetchClientBundle(input: ClientBundleInput): Promise<unknown> {
  const response = await fetch(resolveBundleUrl(input), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) {
    throw new Error(`translation bundle request failed: ${response.status}`);
  }
  return response.json();
}

/** Loads and validates the per-client bundle; throws on transport/HTTP failure. */
export async function loadClientBundle(input: ClientBundleInput): Promise<MessageBundle | null> {
  return sanitizeClientBundle(await fetchClientBundle(input), input.locale);
}

/**
 * Enabled locales the shared UI can actually render. A client may store `ar-SA`/`tr-TR`
 * as "activatable", but until a base bundle ships those entries are ignored; the
 * language control therefore never offers a locale without a bundle.
 */
export function supportedClientLocales(
  config: {
    locales?: { supported?: readonly string[] | null } | null;
  } | null,
): Locale[] {
  const requested = config?.locales?.supported;
  if (requested === null || requested === undefined) {
    return [];
  }
  const enabled: Locale[] = [];
  for (const value of requested) {
    const normalized = normalizeLocale(value);
    if (normalized === undefined) {
      continue;
    }
    const match = matchLocale(normalized, BASE_LOCALES);
    if (match !== undefined && !enabled.includes(match as Locale)) {
      enabled.push(match as Locale);
    }
  }
  return enabled;
}
