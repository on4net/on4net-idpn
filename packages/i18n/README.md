# `@idpn/i18n`

Base message bundles, locale resolution and direction derivation shared by the Hosted UI,
the micro-frontends and the API public config.

## Source of truth

- `messages/fa-IR.json` and `messages/en-US.json` are flat, dot-namespaced keys.
- Both bundles must contain exactly the same keys. `src/messages.ts` asserts parity at
  compile time; `scripts/check-messages.mjs` asserts it at runtime and also rejects
  duplicate keys, empty values, markup and keys outside the documented namespaces.
- Namespaces: `login`, `mfa`, `consent`, `logout`, `account`, `members`, `admin`,
  `audit`, `sessions`, `errors` (plus the small shared `common` namespace).
- Editing a bundle: change both JSON files, then run
  `pnpm --filter @idpn/i18n run check:messages`.

## Resolution

`resolveLocale()` follows `docs/localization.md` 3:

1. explicit host configuration (`configLocale`);
2. `ui_locales`, first enabled entry;
3. `Accept-Language`, highest quality enabled entry;
4. the profile locale;
5. the client default;
6. the tenant default;
7. the app default (`fa-IR`).

Invalid or unsupported values are skipped, never thrown. Only enabled locales are returned.

`resolveDirection()` derives `rtl` for `fa`, `ar`, `he` and `ur`; an override is honoured
only when it is exactly `rtl` or `ltr` (the public config schema validates the source).

## Messages

`translate(locale, key, values)` resolves the current bundle, then the default bundle, then
either the key (development/tests) or a neutral ellipsis (production, so raw keys are never
rendered). It supports `{name}` interpolation and ICU `plural`/`select` basics.
