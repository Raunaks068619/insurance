# TRACK.md — live cross-session memory

The only file that mutates freely. Every agent updates it at session close. Keep it
honest and current — the next agent trusts it instead of re-deriving everything.

## Current focus

Phase 01 framing — lock scope, resolve open questions, then move to domain research.

## Current phase

`01-framing`

## Open questions

- [ ] **Q1 — Prior auth modeling.** Model prior-auth as a simple boolean precondition on the line item (required-by-rule vs. present-on-submission), or as a richer state (pending → approved/denied)? Default leaning: boolean precondition for v1.
- [ ] **Q2 — Out-of-network policy.** Treat OON services as outright not-covered, or support a parallel OON rule set with a worse coinsurance split? Default leaning: in-network only for v1, OON = `NO_COVERAGE`, documented as a deliberate skip.
- [ ] **Q3 — Accumulator period boundaries.** Align accumulators to the policy's fixed plan-year window, or a rolling 12-month period? Default leaning: fixed plan-year window keyed on the policy.

## Blocked

Nothing blocked.

## Decisions log

| # | Date | Decision | Reason | Reversed? |
|---|------|----------|--------|-----------|
| 1 | 2026-06-18 | TypeScript (strict) + Node 20 + vitest | Static types encode the domain and catch money/null bugs at compile time; vitest is fast and test-first friendly. | No |
| 2 | 2026-06-18 | SQLite over Postgres | Reviewer clones and runs with zero DB setup; synchronous better-sqlite3 keeps adjudication deterministic. Postgres adds clone friction for no rubric gain. | No |
| 3 | 2026-06-18 | Typed config over a rules DSL | 80/20 call for a 48h budget: typed coverage-rule records are reviewable and type-checked; a DSL/engine is meta-machinery the assignment explicitly does not reward. | No |
| 4 | 2026-06-18 | Integer cents for all money | Float math on money is the single most common claims bug (coinsurance %, accumulation). Integers make math exact and tests trustworthy. | No |

## Session log

| Date | Agent | Phase | Outcome | Next |
|------|-------|-------|---------|------|
| 2026-06-18 | Claude Code (Opus) | 01-framing | Scaffold created and committed; framing conversation in progress. | Resolve Q1–Q3, log framing decisions, move to 02 domain research. |

## Notes for next agent

- Scaffold lives at the repo root (`/insurance`), not in a nested `claims-system/` — the
  existing `.git` is at the root, so the root *is* the project.
- `project-docs/` holds the original assignment brief. Reference it; do not edit it.
- Nothing in `app/` yet — first code must arrive via a `/tdd-cycle`, test first.
- When you start phase 02, load the `insurance-domain` skill before naming anything.
