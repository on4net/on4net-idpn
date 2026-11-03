import {
  IDPN_MFE_DIRECTIONS,
  IDPN_MFE_MODES,
  IDPN_MFE_MODULES,
  type IdpnLocales,
  type IdpnMfeConfig,
} from './contract.js';
import { isIdpnDirection, isIdpnLocaleCode } from './locale.js';

/**
 * Keys that must never appear in host configuration. Passing a token or a secret here
 * would put it in a place that may be logged, serialized or copied into the DOM, so the
 * helper rejects the call before touching the DOM.
 */
const FORBIDDEN_CONFIG_KEYS = [
  'accessToken',
  'refreshToken',
  'idToken',
  'token',
  'clientSecret',
] as const;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const LOCALE_KEYS = new Set(['default', 'supported', 'dir']);

/** Rejects malformed locale bundles before they reach the DOM or a module root. */
function assertLocales(locales: IdpnLocales): void {
  if (locales === null || typeof locales !== 'object' || Array.isArray(locales)) {
    throw new TypeError('IdpnMfeConfig.locales must be an object.');
  }
  const record = locales as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!LOCALE_KEYS.has(key)) {
      throw new TypeError(`IdpnMfeConfig.locales.${key} is not part of the locale contract.`);
    }
  }
  if (!isNonEmptyString(record['default']) || !isIdpnLocaleCode(record['default'])) {
    throw new TypeError('IdpnMfeConfig.locales.default must be a locale code.');
  }
  const supported = record['supported'];
  if (!Array.isArray(supported) || supported.length === 0) {
    throw new TypeError('IdpnMfeConfig.locales.supported must be a non-empty array.');
  }
  const seen = new Set<string>();
  for (const locale of supported) {
    if (!isNonEmptyString(locale) || !isIdpnLocaleCode(locale)) {
      throw new TypeError('IdpnMfeConfig.locales.supported must contain locale codes.');
    }
    const normalized = locale.toLowerCase();
    if (seen.has(normalized)) {
      throw new TypeError(`IdpnMfeConfig.locales.supported contains duplicate "${locale}".`);
    }
    seen.add(normalized);
  }
  const dir = record['dir'];
  if (dir === null || typeof dir !== 'object' || Array.isArray(dir)) {
    throw new TypeError('IdpnMfeConfig.locales.dir must be an object of rtl/ltr values.');
  }
  for (const [locale, value] of Object.entries(dir)) {
    if (!isIdpnLocaleCode(locale) || !isIdpnDirection(value)) {
      throw new TypeError(`IdpnMfeConfig.locales.dir["${locale}"] must be "rtl" or "ltr".`);
    }
  }
}

/**
 * Validates the host configuration at the SDK boundary. Throws `TypeError` for any invalid
 * or unsafe input; the caller must not mount a partially configured module.
 */
export function assertIdpnMfeConfig(config: IdpnMfeConfig): void {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('IdpnMfeConfig must be an object.');
  }

  const record = config as unknown as Record<string, unknown>;
  for (const key of FORBIDDEN_CONFIG_KEYS) {
    if (key in record) {
      throw new TypeError(
        `IdpnMfeConfig.${key} is not allowed; tokens and secrets stay in the host's memory.`,
      );
    }
  }

  if (!isNonEmptyString(config.clientId)) {
    throw new TypeError('IdpnMfeConfig.clientId must be a non-empty string.');
  }
  if (!IDPN_MFE_MODULES.includes(config.module)) {
    throw new TypeError(`IdpnMfeConfig.module must be one of: ${IDPN_MFE_MODULES.join(', ')}.`);
  }
  if (!IDPN_MFE_MODES.includes(config.mode)) {
    throw new TypeError(`IdpnMfeConfig.mode must be one of: ${IDPN_MFE_MODES.join(', ')}.`);
  }
  if (!isNonEmptyString(config.apiBaseUrl)) {
    throw new TypeError('IdpnMfeConfig.apiBaseUrl must be a non-empty string.');
  }
  if (config.locale !== undefined && !isNonEmptyString(config.locale)) {
    throw new TypeError('IdpnMfeConfig.locale must be a non-empty string when provided.');
  }
  if (config.dir !== undefined && !IDPN_MFE_DIRECTIONS.includes(config.dir)) {
    throw new TypeError(`IdpnMfeConfig.dir must be one of: ${IDPN_MFE_DIRECTIONS.join(', ')}.`);
  }
  if (config.locales !== undefined) {
    assertLocales(config.locales);
  }
  if (config.getAccessToken !== undefined && typeof config.getAccessToken !== 'function') {
    throw new TypeError('IdpnMfeConfig.getAccessToken must be a function when provided.');
  }
  if (config.onEvent !== undefined && typeof config.onEvent !== 'function') {
    throw new TypeError('IdpnMfeConfig.onEvent must be a function when provided.');
  }
  if (
    config.theme !== undefined &&
    (config.theme === null || typeof config.theme !== 'object' || Array.isArray(config.theme))
  ) {
    throw new TypeError('IdpnMfeConfig.theme must be an object of theme tokens.');
  }
}
