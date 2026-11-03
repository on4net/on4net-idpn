---
name: code-cleanup
description: 'Perform safe code cleanup across on4net IDPN: unused imports, dead code, duplicate code, unnecessary abstractions, debug code, obsolete comments, and unnecessary complexity. Use when asked to clean up, tidy, simplify, or remove dead code. Do not change behavior unless explicitly requested.'
argument-hint: 'Scope: api, web, MFE, package, or specific files...'
---

# on4net IDPN Code Cleanup

Perform safe, behavior-preserving cleanup of the on4net IDPN repository.

## When to Use
- The user asks to clean up, tidy, simplify, de-duplicate, or remove dead/debug code.
- You notice unused imports, dead code, or obvious duplication during other work.

## Core Rules
- DO NOT change behavior unless explicitly requested.
- Prefer removing over rewriting. When in doubt, leave it and flag it.
- For larger or structural refactors, load the `refactor` skill instead (`.github/skills/refactor/SKILL.md`).

## Cleanup Targets
- Unused imports
- Dead code (never-called functions, unreachable branches)
- Duplicate code / duplicate components / duplicate utilities
- Unnecessary abstractions (indirection with a single use)
- Debug code (console.log left in, commented-out experiments)
- Obsolete comments (comments that no longer match the code)
- Unnecessary complexity (convoluted logic that can be simplified safely)

## Procedure
1. Identify scope (an app, a package, a folder, or specific files).
2. Search for each cleanup target type (unused imports, dead code, debug prints, duplication).
3. For each candidate, verify it is truly safe to remove:
   - unused import → confirm no references remain (check `packages/*` too — shared code may be imported elsewhere)
   - dead code → confirm no callers / no external reference (within `api/`, `web/`, MFE, and shared packages)
   - debug code → confirm it is not an intentional log
4. Apply removal edits. Do not combine behavior changes with cleanup.
5. Run the relevant checks after cleanup (from repo root or the affected package):
   - Lint: `pnpm lint` (or `pnpm --filter <pkg> lint`)
   - Type-check: `pnpm typecheck`
   - Tests: `pnpm test` for the affected area
6. Report what was removed and what was left with a reason.

## Output Format
- Scope reviewed
- Items removed (by category)
- Items flagged but left (with reason)
- Checks run and results
