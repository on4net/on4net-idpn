---
name: board-loop
description: Drive the on4net IDPN GitHub Project board (Project 2) from empty to drained — claim cards in batches of five, work them one at a time, report, move to In review, then take the next batch. Use when the user asks to "work the board", "do the remaining tasks", "keep going until the board is empty", or when a card has just been moved to In review and the next one must be taken.
---

# The board loop — on4net IDPN (Project 2)

Work the `on4net/on4net-idpn` board (Project 2) without waiting for instructions between cards.

## Board identity

| Item | Value |
|---|---|
| Repository | `on4net/on4net-idpn` |
| Project | `2` (owner `on4net`) |
| Project ID | `PVT_kwDOEVue5c4Bnjku` |
| Status field | `PVTSSF_lADOEVue5c4BnjkuzhmHotg` |
| Status options | `Backlog` `f75ad846` · `Ready` `08afe404` · `In progress` `47fc9ee4` · `In review` `4cc61d42` · `Done` `98236657` |

Always confirm IDs with `gh project field-list 2 --owner on4net` before editing; never guess.

## Use the compact helper

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 counts
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 ready
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 backlog
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 inprogress
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 fill 5
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 claim 8
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 review 8
```

It prints one compact line per card and hides Epics. Raw `gh project item-list` JSON costs
thousands of tokens per call — avoid it.

## The loop

1. **List ready work** — `board.ps1 ready`. If `Ready is EMPTY`, run `board.ps1 fill 5`, then list again.

2. **Claim one card** — `board.ps1 claim <issue>` **before writing any code**.
   The board status is the lock: a card that fails to move is held by another session — skip it.

3. **Work one card at a time.** Do not start the next card before the current one is reported.

4. **Verify the work is actually missing before building.** Read the issue, the referenced docs, and the code. Search for the concept, not just the expected file name. Prefer running the relevant test suite over trusting a claim.

5. **Implement the card's own scope**, following `senior-developer`: state the plan, keep the change minimal, match existing conventions in `api/` and `web/`, no new dependency without a reason.

6. **Test until it demonstrably works.** Run the smallest command that covers the change (`pnpm lint`, `pnpm typecheck`, the affected suite), then the broader suite when the change is cross-cutting. Read the output; never infer success from an exit code. Never weaken an assertion to reach green.

7. **Report on the issue** (`gh issue comment <n> -R on4net/on4net-idpn --body-file …`): what changed, the commit, **actual** test counts, what is verified vs unverified and why, and which acceptance boxes are still unticked. Tick only boxes that are true.

8. **Move the card to `In review`** — `board.ps1 review <issue>` — never to `Done`. `Done` is the project owner's gate. If the move fails, say so in the report and record it in the session notes.

9. **Take the next card.** Do not stop between cards, do not ask whether to continue, and do not report until the board is drained or the user interrupts.

## Refilling Ready

If `Ready` is empty and `Backlog` is not, promote the next five unblocked backlog cards (lowest phase first, then issue number) to `Ready`, then continue the loop.

## Contract per phase

Follow the phase order from `../../docs/roadmap.md`:

| Phase | Scope |
|---|---|
| 0 | Foundation: monorepo, Docker, schema, CI, shadcn/ui bootstrap |
| 1 | OIDC core + Hosted Auth UI + MFE isolation |
| 2 | Management, RBAC, memberships, delegated admin |
| 3 | SSO, logout, sessions, key rotation |
| 4 | Per-client social login, MFA, account lifecycle |
| 5 | App integration and user migration |
| 6 | Hardening, performance, release |

Do not start a task whose declared dependency (in the Epic or body) is still open.

## When a card cannot be finished

Do not stall the loop and do not invent an answer to a product question:

- say on the issue what is missing and why;
- leave the card `In progress` and point at the blocking card or decision;
- file a follow-up issue when the blocker is real work;
- **then take the next card.**

## Statuses and what each means

| Status | Meaning | Your move |
|---|---|---|
| Backlog | not yet chosen | promote to Ready in batches of five |
| Ready | next up, unclaimed | claim it to In progress |
| In progress | claimed — someone is on it | work it if it is yours; otherwise leave it |
| In review | done, at the gate | nothing to do: never move it to Done |
| Done | accepted | nothing |

## If a turn ends mid-loop

End with the last line exactly:

```
NEXT: #<issue> — <title>
```

so that "continue" resumes at that card. **Never end on a question** — the board, not your memory, is the state.