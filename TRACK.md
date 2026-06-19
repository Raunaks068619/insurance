# TRACK.md — live cross-session memory

The only file that mutates freely. Every agent updates it at session close. Keep it
honest and current — the next agent trusts it instead of re-deriving everything.

## Current focus

Phase 01 framing — **all artifacts + actors locked** (Policy, CoverageRule, 12-service
catalog, Member, Claim, LineItem, Adjudication, Accumulator, Dispute; actors: Member,
System/Adjudicator, Insurer). **C2 claim-intake slice (N1–N5) defined.** Next: `/to-prd`
the intake slice and plan the build. Deferred: Q4 dispute-resolution policy, Q6 NEEDS_REVIEW
resolution path. Regenerate the 3 stale infographics (CoverageRule, money-flow, pipeline) to
match the cost-share-union + unit-typed-limit model.

## Current phase

`01-framing`

## Open questions

- [x] **Q1 — Prior auth modeling.** RESOLVED → boolean precondition; missing → `PRIOR_AUTH_REQUIRED`, payable 0. PPO reduce-to-50% penalty documented as a divergence, not built.
- [x] **Q2 — Out-of-network policy.** RESOLVED → in-network only for v1 (allowed == billed); OON/unlisted service → `NO_COVERAGE`. Network/metal-tier/family fields omitted (no math impact).
- [x] **Q3 — Accumulator period boundaries.** RESOLVED → fixed plan-year window keyed on the policy.
- [x] **Q5 — Duplicate handling.** RESOLVED → fingerprint (`member_id + service_code + service_date + billed_cents`) computed at **intake**; the duplicate *decision* is made at **adjudication** as a soft `DUPLICATE_LINE_ITEM` (payable 0). Not an intake reject.
- [ ] **Q4 — Dispute resolution.** Auto re-adjudicate vs. reviewer queue. Leaning auto, original preserved immutably. (C6, deferred.)
- [ ] **Q6 — NEEDS_REVIEW resolution path.** With no human reviewer in scope, how does a `NEEDS_REVIEW` line (prior-auth missing) resolve? Leaning: member re-submits with `prior_auth_present=true`; manual review out of scope. (C3/C6, deferred.)

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
| 8 | 2026-06-18 | Reimbursement model (plan → member); PAID via explicit settle action, gateway success assumed | Brief says "claims for reimbursement" and lists `paid` in the lifecycle. No real payment processing in scope → record the transition. Likely a 5th interface action. | No |
| 9 | 2026-06-18 | Member = opaque `member_id` anchor; PII minimized/separated, encryption-at-rest candidate | Brief flags sensitive health data; engine adjudicates on `member_id → policy + accumulators` and never needs the name. One human persona (no auth/roles). | No |
| 10 | 2026-06-18 | `NEEDS_REVIEW` is a valid line state (locked); prior-auth *routing* to it is **PROVISIONAL** | State comes from infographic 04 + brief's "1 needs review". The *routing rule* is C3 adjudication behavior — confirmed in the C3 brainstorm, would revise #7. | Provisional |
| 11 | 2026-06-18 | Capture `diagnosis_code` + `provider` on the Claim as encrypted, non-adjudicated PHI | Brief names them as sensitive data; capturing is where we *demonstrate* the PHI stance. Revises the earlier omit-lean (Fork #2). | No |
| 12 | 2026-06-18 | Claim + LineItem attributes locked; 12-code closed service catalog; `service_date` at claim level; `units` per line; Adjudication `reasons[]` array | Matches the infographics. Unlisted `service_code` → `NO_COVERAGE`. `reasons[]` array revises the single-dominant-code stance. | No |
| 13 | 2026-06-18 | C2 intake = N1–N5; reject = HTTP 4xx, never persisted (no `REJECTED` state); member-existence = intake reject, policy-active = adjudication deny | Industry reject≠deny boundary (Stedi: once adjudicated, can only be denied). A reject never enters the system. | No |
| 14 | 2026-06-18 | Accumulator carries `deductible_met_cents` + `oop_met_cents` + per-service `limit_used` | Infographic 02 omitted `deductible_met`; the deductible draw at adjudication needs it. | No |

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
| 2026-06-18 | Claude Code (Opus) | 01-framing → 02-domain-research | Researched claim intake (UHC/Cigna/Aetna + CMS-1500/837); **locked all artifacts + actors**; defined the C2 intake slice (N1–N5); adopted `NEEDS_REVIEW` + `dx_code`/`provider` PHI capture per the infographics; closed Q5. | `/to-prd` the intake slice; regenerate the 3 stale infographics; resolve Q4/Q6 when adjudication (C3) starts. |

## Notes for next agent

- Scaffold lives at the repo root (`/insurance`), not in a nested `claims-system/` — the
  existing `.git` is at the root, so the root *is* the project.
- `project-docs/` holds the original assignment brief. Reference it; do not edit it.
- Nothing in `app/` yet — first code must arrive via a `/tdd-cycle`, test first.
- When you start phase 02, load the `insurance-domain` skill before naming anything.
