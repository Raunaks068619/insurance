# TRACK.md — live cross-session memory

The only file that mutates freely. Every agent updates it at session close. Keep it
honest and current — the next agent trusts it instead of re-deriving everything.

## Current focus

Phase 01 framing — coverage/policy model **locked** (cost-share union + unit-typed limits,
grounded in real-insurer research). Next: resolve dispute + duplicate handling, then close
framing and move to design.

## Current phase

`01-framing`

## Open questions

- [x] **Q1 — Prior auth modeling.** RESOLVED → boolean precondition; missing → `PRIOR_AUTH_REQUIRED`, payable 0. PPO reduce-to-50% penalty documented as a divergence, not built.
- [x] **Q2 — Out-of-network policy.** RESOLVED → in-network only for v1 (allowed == billed); OON/unlisted service → `NO_COVERAGE`. Network/metal-tier/family fields omitted (no math impact).
- [x] **Q3 — Accumulator period boundaries.** RESOLVED → fixed plan-year window keyed on the policy.
- [ ] **Q4 — Dispute resolution.** Auto re-adjudicate vs. reviewer queue. Leaning auto, original preserved immutably.
- [ ] **Q5 — Duplicate handling.** Hard reject vs. soft duplicate flag. Leaning soft flag, `DUPLICATE_LINE_ITEM`.

## Blocked

Nothing blocked.

## Decisions log

| # | Date | Decision | Reason | Reversed? |
|---|------|----------|--------|-----------|
| 1 | 2026-06-18 | TypeScript (strict) + Node 20 + vitest | Static types encode the domain and catch money/null bugs at compile time; vitest is fast and test-first friendly. | No |
| 2 | 2026-06-18 | SQLite over Postgres | Reviewer clones and runs with zero DB setup; synchronous better-sqlite3 keeps adjudication deterministic. Postgres adds clone friction for no rubric gain. | No |
| 3 | 2026-06-18 | Typed config over a rules DSL | 80/20 call for a 48h budget: typed coverage-rule records are reviewable and type-checked; a DSL/engine is meta-machinery the assignment explicitly does not reward. | No |
| 4 | 2026-06-18 | Integer cents for all money | Float math on money is the single most common claims bug (coinsurance %, accumulation). Integers make math exact and tests trustworthy. | No |
| 5 | 2026-06-18 | Cost-share as a discriminated union (`full_coverage`\|`copay`\|`coinsurance`) | Real benefits (UHC/Aetna/Cigna/BCBS/ACA) use exactly one mechanism per service; union makes the model say it and the adjudicator an exhaustive switch. | No |
| 6 | 2026-06-18 | Unit-typed limits (`none`\|`dollars`\|`visits`) | The most common real limit is a visit/day cap, which a dollars-only field can't express; dollars still satisfies the brief's "$Y/yr". | No |
| 7 | 2026-06-18 | Prior-auth = clean denial; OON/network/metal/family omitted | Each stored field must trace to a real adjudication effect in a single-network, per-member, allowed==billed v1. | No |

## Domain research findings (2026-06-18)

Source: 6-agent web research across UnitedHealthcare, Aetna, Cigna, BCBS SBCs + ACA/CMS;
synthesis in `ai-artifacts/02-domain-research/`. Key findings that shaped the model:

- **Three cost-share modes, never a stack:** preventive = free (ACA, no deductible); office/
  specialist/urgent/ER = flat **copay** (deductible waived); imaging/surgery/hospital =
  **coinsurance after deductible**. ER's copay-then-coinsurance is the one common exception.
- **Visit/day limits dominate** (PT ~20–60/yr, home health ~60–120/yr, SNF ~25–180 days/yr);
  **dollar limits are rare** (chiro ~$1,500/yr, hearing aids, infertility). → limits need a unit.
- **Copay waives deductible but counts to OOP; coinsurance applies deductible first.** Kept as an
  explicit per-rule `applies_deductible` bool (exceptions exist) rather than derived.
- **Two "no"s:** explicit `excluded` (adult dental/vision) vs. no rule at all → `NO_COVERAGE`.
- **Dropped as no-math-impact in v1:** metal tier, HMO/PPO network, OON tier, family deductible,
  separate Rx deductible, referral gating.

## Session log

| Date | Agent | Phase | Outcome | Next |
|------|-------|-------|---------|------|
| 2026-06-18 | Claude Code (Opus) | 01-framing | Scaffold created and committed; framing conversation in progress. | Resolve Q1–Q3, log framing decisions, move to 02 domain research. |
| 2026-06-18 | Claude Code (Opus) | 01-framing → 02-domain-research | Ran real-insurer coverage research; locked cost-share union + unit-typed limits + 12-rule seed set; resolved Q1–Q3; propagated to PRD, insurance-domain skill, docs/, and artifacts. | Resolve Q4 (dispute) + Q5 (duplicate), then close framing → design. |

## Notes for next agent

- Scaffold lives at the repo root (`/insurance`), not in a nested `claims-system/` — the
  existing `.git` is at the root, so the root *is* the project.
- `project-docs/` holds the original assignment brief. Reference it; do not edit it.
- Nothing in `app/` yet — first code must arrive via a `/tdd-cycle`, test first.
- When you start phase 02, load the `insurance-domain` skill before naming anything.
