# Style isolation (Tailwind v4 + Radix) — Implementation notes

> Scope: how the shared MFE/Hosted UI stylesheet stays inside `.idpn-root`, how Radix
> overlays find their container, and what the isolation tests assert. The normative rules
> remain in [design-system.md](./design-system.md) 7 and [micro-frontend.md](./micro-frontend.md) 7.

## 1. Import strategy

`web/src/styles/globals.css` deliberately imports **only** utilities:

```css
@layer theme, base, components, utilities;
@import 'tailwindcss/utilities.css' layer(utilities);
```

`tailwindcss/theme.css` and `tailwindcss/preflight.css` are **not** imported:

- `theme.css` emits `:root, :host { … }` custom properties, so a module would write its
  Tailwind defaults into the host document.
- Preflight is a global reset and would restyle host elements.

The small part of Tailwind's default scale that shared components use (`--spacing`,
`--font-mono`, text sizes, shadows, `--animate-spin`, …) is declared with `@theme inline`.
Inline theme values are baked into the generated utilities instead of being emitted as
global custom properties, so the built CSS contains no `:root`/`:host` block.

The only global at-rule the stylesheet emits is its own uniquely named animation,
`@keyframes idpn-spin`; a generic `spin` name would collide with a host's keyframes.

### 1.1 Scoping generated utilities (Module Federation)

The remote stylesheet is injected into the host document, so the generated utilities are
wrapped in `@scope (.idpn-root)` by the `idpn-scope-utilities` Vite plugin
(`web/src/styles/scope-utilities.ts`, enabled in `vite.mfe.config.ts`). A host element that
happens to use a class such as `start-4` therefore keeps its browser default; only
descendants of the module root receive the utility.

The Hosted UI build is not scoped (it owns the document), and the Web Component build does
not need the transform because Shadow DOM already isolates both directions.

## 2. Host globals must not break the module

Module Federation hosts often ship Tailwind Preflight in the global `base` layer. A scoped
reset is therefore part of the module stylesheet:

- `.idpn-root *` (and pseudo-elements) uses `all: revert` in the `base` layer, undoing host
  author rules for module descendants;
- the reset re-applies `box-sizing: border-box` and the form-control `font/color/letter-spacing`
  inheritance the module relies on;
- the reset stays in `base`, so `components`/`utilities` (and therefore every shadcn utility
  class) still win.

This protects against layered host resets (the normal Tailwind case). A host rule declared
completely unlayered still outranks all layered MFE CSS; the only complete isolation for
unlayered host CSS is the Web Component's Shadow DOM.

## 3. Tokens are local to each root

- Client values arrive as inline `--idpn-*` custom properties on `.idpn-root`.
- `.idpn-root` **declares defaults for every `--idpn-*` name itself**, rather than relying
  only on `var(--idpn-x, fallback)`. A host that sets `--idpn-primary` on `body`/`:root`
  therefore cannot restyle the module.
- Semantic shadcn variables (`--background`, `--primary`, `--radius`, …) are assigned from
  those `--idpn-*` values inside `.idpn-root`; `:root` is never touched.
- Two or more instances on one page keep independent themes because each root owns its
  inline token set and its own portal host.

## 4. Radix portal contract

`web/src/app/idpn-root.tsx` provides the single contract used by `DialogContent` and
`SelectContent`:

| Situation                                     | Target                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| `container` prop supplied                     | that element (passing `null` throws `PortalContainerError`)               |
| inside `IdpnRoot`                             | the root's `[data-idpn-portal-root]` node                                 |
| inside `IdpnRoot`, before the ref commits     | `null` → the overlay renders nothing for one tick (never `document.body`) |
| outside `IdpnRoot` (standalone admin surface) | `document.body` (legacy fallback, documented)                             |

`usePortalContainer()` / `usePortalScope()` expose the scoped node. Portal nodes are inside
`.idpn-root`, so they inherit its tokens, direction and scoped reset. In the Web Component,
`.idpn-root` and the portal host live inside the Shadow Root, so overlays never reach the
host `document.body`. Nested dialogs/selects keep using the same React context and therefore
the same portal host.

## 5. Verification

| Check                                                                  | Where                                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| No `:root`/`:host` variables in built CSS                              | `build`/`build:wc` output + Playwright `isolation.spec.ts`                   |
| Host CSS ↔ MFE computed styles                                         | `e2e/web/isolation.spec.ts`, `mf-host.spec.ts`, `web-component-host.spec.ts` |
| MFE utilities do not match host elements                               | `mf-host.spec.ts` (`#host-unscoped-probe`, class `start-4`)                  |
| Utilities scope transform                                              | `web/src/styles/scope-utilities.test.ts`                                     |
| Portal parent is `.idpn-portal-root` inside `.idpn-root` / Shadow Root | `e2e/web/{isolation,mf-host,web-component-host}.spec.ts`                     |
| Nested Dialog + Select use the same portal host                        | `web/src/components/ui/portal-isolation.test.tsx`                            |
| Two instances with different themes                                    | `e2e/web/isolation.spec.ts`                                                  |
| Portal resolution / invalid container guard                            | `web/src/app/idpn-root.test.tsx`                                             |

When a new shadcn component starts using another default-theme utility, add the corresponding
`@theme inline` value and extend the isolation assertions if the component portals.
