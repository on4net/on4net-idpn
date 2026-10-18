---
name: dependency-review
description: 'Review dependency changes in on4net IDPN: vulnerabilities, breaking changes, compatibility, and unnecessary dependencies. Use when dependencies are added, updated, or removed, when checking for known CVEs, or when verifying that a dependency upgrade will not break the build. Covers package.json files across api/, web/, packages/ plus pnpm-lock.yaml.'
argument-hint: 'Dependency to review or the change in question...'
---

# on4net IDPN Dependency Review

Review dependency changes for on4net IDPN.

## Manifest Files
- Root: `package.json` + `pnpm-workspace.yaml` + `pnpm-lock.yaml`
- Backend: `api/package.json`
- Frontend: `web/package.json`
- Shared packages: `packages/*/package.json`
- Internal deps use `"workspace:*"` where applicable

## When to Use
- A dependency is added, updated, or removed.
- The user asks to check for vulnerable, outdated, or unnecessary dependencies.
- A build/test failed after a dependency change.

## Check Categories
- **Vulnerabilities** — known CVEs for the added/updated packages (`pnpm audit`).
- **Breaking changes** — does the new major version change APIs used by the code? Search the codebase for usages.
- **Compatibility** — does the version satisfy peer/transitive requirements and the runtime (Node LTS, React 19, Vite, Tailwind v4, shadcn CLI, Fastify, TypeScript)? Keep `typescript`, `vitest`, `eslint`, `tailwindcss`, `@radix-ui/*` aligned with the workspace.
- **Necessity** — is the dependency actually used? Could an existing dependency or built-in suffice?
- **Workspace consistency** — are internal deps kept on `workspace:*` and used via `pnpm --filter`?
- **Lockfiles** — is `pnpm-lock.yaml` updated consistently so `pnpm install --frozen-lockfile` works?

## Procedure
1. Identify the dependency change.
2. Check the manifest(s) and lockfile.
3. Run `pnpm audit` and scan for known vulnerabilities in the affected packages.
4. Search the codebase for usages to assess breaking-change impact.
5. Determine if the dependency is necessary or redundant.
6. Report findings with severity and recommended action.

## Output Format
- Dependency and version change
- Vulnerability findings (CVE, severity)
- Breaking-change assessment
- Compatibility notes
- Necessity verdict (keep / replace / remove)
- Recommended action
