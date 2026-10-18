---
name: ui-styling
description: Add, patch or review shadcn/ui components in on4net IDPN (web/src/components/ui) — pinned CLI usage, token rules, RTL/portal patches, UPSTREAM inventory and review checklist. Use when adding a UI component, styling a screen, or reviewing UI changes.
---

# UI styling — shadcn/ui in on4net IDPN

The design system is **shadcn/ui + Tailwind v4**, vendored into `web/src/components/ui`.
`docs/design-system.md` is the standard; this skill is the operating procedure.

## Non-negotiable rules

1. **Components come from the pinned shadcn CLI only.**
   `pnpm --filter @idpn/web ui:add <component>` — runs `pnpm dlx shadcn@4.22.0 add` (the CLI is never installed).
   Never copy component source from a blog, gist, another project, or an unapproved registry.
2. **No runtime dependency on the CLI.** `shadcn` stays in `devDependencies`; the app imports only
   `web/src/components/ui/*` and `web/src/lib/utils.ts`.
3. **Tokens only.** Use semantic tokens (`bg-background`, `text-foreground`, `border-border`, `--idpn-*`).
   Hard-coded palette classes (`bg-red-500`) and arbitrary hex values are rejected in review.
4. **Preflight stays out of the MFE.** `web/src/styles/globals.css` imports only
   `tailwindcss/theme.css` and `tailwindcss/utilities.css`. Adding `tailwindcss`/preflight resets host apps.
5. **Tokens live on `.idpn-root`,** never `:root`, so several apps/themes can coexist.
6. **Every Radix portal takes `container`** (`Dialog`, `Select`, future `Popover`/`Tooltip`) and receives it
   from `usePortalContainer()`; portals must render inside `.idpn-root`.
7. **RTL first.** Use logical utilities (`ps-/pe-/ms-/me-/start-/end-/text-start/text-end`); directional icons
   rotate with `rtl:rotate-180`; dialogs are centered with flex, not `translate-x`.
8. **Accessibility is part of "done".** Labels for inputs, `aria-invalid`/`aria-describedby` for errors,
   focus visible, keyboard operation, axe with zero Critical/Serious.
9. **Every component is inventoried.** Add a row to `web/UPSTREAM.md` (source, date, local patches) in the
   same change that adds the component.
10. **Every component has tests.** RTL/A11y behaviour in `web/src/components/ui/components.test.tsx`
    (or a dedicated test file) and, for interactive flows, an E2E assertion.

## Workflow to add a component

```powershell
pnpm --filter @idpn/web ui:add <component>     # 1. add from the pinned registry
# 2. apply RTL/portal patches if the component uses portals or directional utilities
# 3. add a row to web/UPSTREAM.md (version, date, patches)
# 4. add/update tests (RTL + keyboard + a11y)
pnpm --filter @idpn/web typecheck
pnpm --filter @idpn/web test:coverage
pnpm test:e2e
```

## Allowed components (current inventory)

`alert`, `badge`, `button`, `card`, `dialog`, `form`, `input`, `label`, `scroll-area`, `select`, `spinner`,
`table`, `tabs` — see `web/UPSTREAM.md` for versions and patches.

## Ownership

| Area | Owner | Scope |
|---|---|---|
| Design system / `web/src/components/ui` | Design System owner | Components, tokens, `UPSTREAM.md`, upgrades |
| `web/src/app` (Hosted Auth UI) | Auth UI owner | Login/MFA screens, RTL, A11y |
| `web/src/mfe` (embedded modules) | Frontend lead | MFE modules, isolation, host contracts |
| `web/src/styles` (tokens/theme) | Design System owner | `globals.css`, `--idpn-*`, dark mode |

Names for each role are assigned by the project owner; the role table is the review contract.

New components need the Design System owner's agreement (recorded on the issue) before the CLI is run.

## Upgrade policy

- Registry/CLI upgrades are **pinned and deliberate**: bump `shadcn` in `web/package.json`, regenerate the
  component, and record the change in `web/UPSTREAM.md` with the date and re-applied patches.
- Never auto-update components. Review diffs for RTL, portal and token regressions.
- Run the full checklist (typecheck, unit coverage, E2E) after any upgrade.

## Review checklist

- [ ] Component comes from the pinned CLI; no manual copy.
- [ ] Row exists in `web/UPSTREAM.md` with patches.
- [ ] Only semantic tokens; no raw palette/hex.
- [ ] Preflight untouched; tokens still on `.idpn-root`.
- [ ] Portals render inside `.idpn-root`.
- [ ] RTL uses logical utilities; Persian text renders correctly.
- [ ] Keyboard + screen reader behaviour tested; axe clean.
- [ ] Tests added/updated; coverage thresholds still met.
