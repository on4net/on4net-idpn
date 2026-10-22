#!/usr/bin/env node
/**
 * Validates the base bundles (docs/localization.md 4).
 *
 * Fails on: duplicate keys in the JSON text, missing/extra keys between locales, empty or
 * non-string values, keys outside the documented namespaces, a missing required namespace,
 * and values that contain markup.
 *
 * Usage: node scripts/check-messages.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Top-level namespaces of the base bundles. */
export const ALLOWED_NAMESPACES = [
  'account',
  'admin',
  'audit',
  'common',
  'consent',
  'errors',
  'language',
  'login',
  'logout',
  'members',
  'mfa',
  'sessions',
];

export const REQUIRED_NAMESPACES = [
  'login',
  'mfa',
  'consent',
  'logout',
  'account',
  'members',
  'admin',
  'audit',
  'sessions',
  'errors',
];

const BUNDLE_PATHS = {
  'fa-IR': fileURLToPath(new URL('../messages/fa-IR.json', import.meta.url)),
  'en-US': fileURLToPath(new URL('../messages/en-US.json', import.meta.url)),
};

/** Top-level JSON keys in the raw text; used to catch duplicates `JSON.parse` hides. */
export function duplicateKeys(raw) {
  const seen = new Set();
  const duplicates = new Set();
  const pattern = /"((?:[^"\\]|\\.)*)"\s*:/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const key = match[1];
    if (seen.has(key)) {
      duplicates.add(key);
    }
    seen.add(key);
  }
  return [...duplicates];
}

/** @returns {string[]} validation errors (empty when the bundle pair is valid). */
export function validateBundles(rawBundles) {
  const errors = [];
  const parsed = {};

  for (const [locale, raw] of Object.entries(rawBundles)) {
    const duplicates = duplicateKeys(raw);
    if (duplicates.length > 0) {
      errors.push(`${locale}: duplicate keys: ${duplicates.join(', ')}`);
    }
    try {
      parsed[locale] = JSON.parse(raw);
    } catch (error) {
      errors.push(`${locale}: invalid JSON (${error.message})`);
    }
  }

  const locales = Object.keys(parsed);
  if (locales.length === 0) {
    return errors.length > 0 ? errors : ['no bundles found'];
  }

  for (const locale of locales) {
    const bundle = parsed[locale];
    if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
      errors.push(`${locale}: bundle must be an object`);
      continue;
    }
    for (const [key, value] of Object.entries(bundle)) {
      if (typeof value !== 'string' || value.trim() === '') {
        errors.push(`${locale}: ${key} must be a non-empty string`);
        continue;
      }
      const namespace = key.split('.')[0];
      if (!ALLOWED_NAMESPACES.includes(namespace)) {
        errors.push(`${locale}: ${key} is outside the allowed namespaces`);
      }
      if (/[<>]/.test(value)) {
        errors.push(`${locale}: ${key} must be plain text (no markup)`);
      }
    }
  }

  const [reference, ...others] = locales;
  const referenceKeys = new Set(Object.keys(parsed[reference]));
  for (const locale of others) {
    const keys = new Set(Object.keys(parsed[locale]));
    for (const key of referenceKeys) {
      if (!keys.has(key)) {
        errors.push(`${locale}: missing key ${key}`);
      }
    }
    for (const key of keys) {
      if (!referenceKeys.has(key)) {
        errors.push(`${reference}: missing key ${key} (present in ${locale})`);
      }
    }
  }

  for (const namespace of REQUIRED_NAMESPACES) {
    if (![...referenceKeys].some((key) => key.split('.')[0] === namespace)) {
      errors.push(`required namespace "${namespace}" has no keys`);
    }
  }

  return errors;
}

function main() {
  const rawBundles = {};
  for (const [locale, path] of Object.entries(BUNDLE_PATHS)) {
    rawBundles[locale] = readFileSync(path, 'utf8');
  }
  const errors = validateBundles(rawBundles);
  if (errors.length > 0) {
    console.error('Message bundle check failed:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  const count = Object.keys(JSON.parse(rawBundles['fa-IR'])).length;
  console.info(`Message bundles OK: ${count} keys x ${Object.keys(BUNDLE_PATHS).length} locales.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
