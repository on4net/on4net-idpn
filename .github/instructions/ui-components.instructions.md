---
applyTo: 'web/src/components/ui/**,web/src/app/**,web/src/mfe/**,web/src/styles/**'
description: shadcn/ui component governance for on4net IDPN UI code.
---

# UI component governance

These rules apply to any change under `web/src/components/ui`, `web/src/app` and `web/src/mfe`.

1. **Source of components:** shadcn/ui via the pinned CLI only
   (`pnpm --filter @idpn/web ui:add <component>`, `shadcn@4.22.0`).
   Do **not** hand-copy component code from blogs, gists, other repositories or unapproved registries.
2. **Inventory:** every component added or patched gets a row in `web/UPSTREAM.md`
   (source, date, local patches) in the same change.
3. **Tokens:** use semantic Tailwind tokens and `--idpn-*` variables. Raw palette classes
   (`bg-red-500`) and hex values are rejected.
4. **Isolation:** never import Tailwind preflight (or `tailwindcss/theme.css`) into MFE styles;
   tokens stay on `.idpn-root`; shared Radix wrappers resolve the portal container themselves —
   never pass `container={usePortalContainer()}` from a call site.
5. **RTL:** logical utilities only (`ps/pe/ms/me/start/end/text-start/text-end`); verify Persian rendering.
6. **A11y:** labels, `aria-invalid`/`aria-describedby`, keyboard operation, focus visible;
   axe must report zero Critical/Serious.
7. **Tests:** add RTL/A11y tests next to the component and keep coverage thresholds
   (`web/vitest.config.ts`) green.

Full procedure: `.github/skills/ui-styling/SKILL.md`. Standard: `docs/design-system.md`.
