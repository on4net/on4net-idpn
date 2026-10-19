# UI accessibility and visual regression suites

These suites cover every shipped shadcn/ui surface: Hosted Auth UI (login, MFA), the
`account` and `user-management` micro-frontends, and the admin console (users, sessions,
audit), including dialogs/selects in their open state.

| What                        | Spec                          | Project           |
| --------------------------- | ----------------------------- | ----------------- |
| axe (Critical/Serious gate) | `e2e/a11y/surfaces.spec.ts`   | `a11y-chromium`   |
| Screenshot baselines        | `e2e/visual/surfaces.spec.ts` | `visual-chromium` |

## Commands

```powershell
# Accessibility gate — starts only the Vite dev server and mocks every IdP call.
pnpm test:a11y

# Visual comparison against the committed baselines.
pnpm test:visual

# Regenerate baselines after an intentional UI change (review the new images in the PR).
pnpm test:visual:update
```

The same projects are registered in `playwright.config.ts`, so `pnpm test:e2e` runs them
with the rest of the E2E suite.

CI runs two dedicated jobs in `.github/workflows/ci.yml`: `ui-a11y` on `ubuntu-latest`
(platform-independent axe gate) and `ui-visual` on `windows-latest` (the committed
`win32` baselines). Neither needs a database or social provider.

`playwright.ui.config.ts` deliberately starts no API/BFF process and no database, Redis or
social provider: `e2e/support/ui-fixtures.ts` answers `/api/v1/**` at the route layer with
stable fixtures. The suites are therefore safe for CI jobs that gate the shared UI without
infrastructure.

## Surfaces and the test harness

Hosted login and MFA are real product routes (`/?client_id=…&ui_locales=…`). The account
module, user-management and the admin console have no standalone route — a host mounts
them. `web/harness/` is a development/Playwright-only page that mounts the real
`AccountRoot`, `UserManagementRoot` and `mountAdminConsole` with the same tokens a host
uses:

```
/harness/?surface=account|user-management|admin&locale=fa-IR|en-US
```

Vite serves it in development; `vite build` bundles only `index.html`, so the harness is
never part of a production build. Query parameters are test configuration only and no
product surface reads them.

## Determinism

- Fixed viewport `1280×800`, `deviceScaleFactor: 1`, UTC, locale `fa-IR` (config level).
- Fixtures use fixed timestamps; the API is mocked, so no clock or data drift.
- Screenshots disable animations and the caret (`expect.toHaveScreenshot` options).
- Dark mode uses the documented `.dark` class on the shared root plus `#53` dark tokens;
  theme transitions are disabled before axe/screenshots so both read settled values.
- Only the system font stack is used (no remote font requests).

## Baselines

`e2e/visual/__screenshots__/<platform>/` holds one image per scenario. Playwright's
`{platform}` token is part of the path because font rasterisation differs between operating
systems. When a UI change is intentional:

1. run `pnpm test:visual:update`;
2. inspect every changed image;
3. commit the images with the implementation in the same change.

Do not update baselines to silence an unexpected diff — first decide whether the diff is a
regression.

## Notes

- Component-level axe checks live in `web/src/components/ui/a11y.test.tsx` and run in the
  fast Vitest suite. jsdom has no layout or contrast engine, so `color-contrast` is
  evaluated only by the Playwright scans; everything else (names, roles, ARIA, listbox and
  table semantics) runs in both layers.
- The Playwright gate fails only on axe `critical`/`serious`, and prints the rule id,
  impact, selector and failing snippet on failure.
