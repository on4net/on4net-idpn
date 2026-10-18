---
name: accessibility-review
description: 'Review web accessibility of on4net IDPN (Hosted Auth UI + embedded MFE): keyboard navigation, semantic HTML, labels, focus management, ARIA, contrast, and screen reader compatibility. Use when asked to check accessibility, make the UI accessible, or fix keyboard/ARIA/contrast issues.'
argument-hint: 'Page or component to review for accessibility...'
---

# on4net IDPN Web Accessibility Review

Review the accessibility of the on4net IDPN Hosted Auth UI and embedded micro-frontends (React 19 + Vite + shadcn/ui + Tailwind v4).

## When to Use
- The user asks to check or fix accessibility.
- You are reviewing or building a page/component and want to ensure it is accessible.
- Keyboard navigation, screen reader, or contrast issues are reported.

## Web Apps
- `web/` — Hosted Auth UI (login, MFA, social, reset)
- `web/` or `packages/ui` — embedded MFE (`account`, `user-management`)
- Shared UI components live under the configured shadcn `ui` alias (usually `@/components/ui`) and `packages/ui`.
- Source of truth for tokens and RTL: `docs/design-system.md`.

## Check Categories
- **Keyboard navigation** — every interactive element reachable and operable with Tab/Enter/Space; visible focus; no keyboard traps; logical tab order.
- **Semantic HTML** — use native elements (`button`, `a`, `nav`, `main`, `h1-h6`, `form`, `label`) instead of bare `div`/`span` with click handlers.
- **Labels** — every form control has an accessible label (`<label>`, `aria-label`, `aria-labelledby`).
- **Focus management** — modals/dialogs trap and restore focus; route changes move focus to the new heading.
- **ARIA** — correct roles/attributes; no redundant or misused ARIA; `aria-live` for dynamic updates.
- **Contrast** — text meets WCAG AA contrast (4.5:1 normal, 3:1 large); not relying on color alone.
- **Screen reader** — meaningful alt text, heading structure, link/button names, form error announcements.

## Procedure
1. Identify the page/component in scope.
2. Inspect the JSX/TSX for the categories above.
3. Note missing semantic elements, labels, focus handling, and ARIA.
4. Check the CSS/Tailwind for contrast issues.
5. Report findings with severity and file references.

## Output Format
- Scope reviewed
- Findings by category (keyboard / semantics / labels / focus / ARIA / contrast / screen reader)
- Severity per finding (with file references)
- Recommended fixes
