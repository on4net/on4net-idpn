---
name: i18n-rtl-review
description: 'Review internationalization and RTL/LTR compatibility in on4net IDPN Hosted Auth UI and embedded MFE. Pay special attention to Persian and English interfaces, layout direction, text alignment, localization, dates, numbers, and translated strings. Use when checking i18n coverage, RTL layout, missing translations, or Persian text rendering.'
argument-hint: 'i18n / RTL area to review: language, layout, dates, numbers, or translations...'
---

# on4net IDPN i18n / RTL Review

Review internationalization and RTL/LTR compatibility across the Hosted Auth UI and embedded micro-frontends.

## Context
- Primary locales: Persian (`fa`, RTL) and English (`en`, LTR).
- Web: React 19 + Vite + shadcn/ui + Tailwind v4 in `web/` and `packages/ui`.
- Locale-sensitive data: dates, numbers, currencies, and code/identifiers embedded in RTL sentences.
- Source of truth for tokens, fonts and RTL rules: `docs/design-system.md`.

## When to Use
- The user asks to check translations, RTL layout, or locale handling.
- A feature displays text, dates, numbers, or currencies and must work in both Persian and English.
- New UI strings need to be localized.

## Check Categories
- **Localization** — user-facing strings go through the i18n system (no hardcoded UI text where a mechanism exists); translation keys exist for all locales.
- **Missing translations** — any key missing in `fa` or `en`; fallback behavior defined.
- **Layout direction** — RTL pages set the correct `dir="rtl"`; LTR content (code, emails, URLs) stays LTR.
- **Text alignment** — alignment is logical (start/end) rather than hardcoded left/right.
- **Dates and numbers** — formatted with locale-aware APIs (Intl, date-fns) so Persian digits/calendars and English formats render correctly.
- **Currency** — amounts formatted for the user's locale, not hardcoded `$`.
- **Mixed content** — embedded LTR text (tokens, IDs, code) renders correctly inside RTL sentences.
- **Icons/chevrons** — direction-aware icons flip or reorder correctly in RTL.

## Procedure
1. Identify the screen/page/string set in scope.
2. Verify strings use the i18n system and exist in all locale files.
3. Check layout/alignment for RTL correctness.
4. Check date/number/currency formatting for locale awareness.
5. Report findings with severity and file references.

## Output Format
- Scope reviewed
- Findings by category (localization / missing translations / layout direction / alignment / dates / numbers / currency / mixed content / icons)
- Severity per finding (with file references)
- Recommended fixes
