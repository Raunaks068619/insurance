# TRACK.md — live cross-session memory

The only file that mutates freely. Every agent updates it at session close. Keep it
honest and current — the next agent trusts it instead of re-deriving everything.

## Current focus

Framing + design **closed**. C3 adjudication behavior locked in
[`docs/adjudication-plan.md`](docs/adjudication-plan.md) (pipeline, cost-share math,
determinism, writeback). **Lifecycle strengthened this session:** dropped `PAID`/settle from v1
(#19 — claim ends at APPROVED/PARTIALLY_APPROVED/DENIED; dispute reopens → UNDER_REVIEW), and
added a **status-transition audit log** (#20 — one append-only table via a `setStatus()`
chokepoint, surfaced on `GET /claims/:id`). **TDD build order now 31 cycles** (28–31 = the
transition log). **In progress: detailing the dispute events** (what a dispute writes +
re-adjudication transitions) — then start TDD cycle 1 (`no rule → NO_COVERAGE`). Q4 (dispute
auto vs queue) still open; being resolved in the dispute-events discussion. (Housekeeping:
regenerate the 3 stale infographics.)

## Current phase

`03-design` complete → `04-coding` (TDD) next — first red test is cycle 1.

## Open questions

- [x] **Q1 — Prior auth modeling.** RESOLVED → boolean precondition; missing → `PRIOR_AUTH_REQUIRED`, payable 0. PPO reduce-to-50% penalty documented as a divergence, not built.
- [x] **Q2 — Out-of-network policy.** RESOLVED → in-network only for v1 (allowed == billed); OON/unlisted service → `NO_COVERAGE`. Network/metal-tier/family fields omitted (no math impact).
- [x] **Q3 — Accumulator period boundaries.** RESOLVED → fixed plan-year window keyed on the policy.
- [x] **Q5 — Duplicate handling.** RESOLVED → fingerprint (`member_id + service_code + service_date + billed_cents`) computed at **intake**; the duplicate *decision* is made at **adjudication** as a soft `DUPLICATE_LINE_ITEM` (payable 0). Not an intake reject.
- [x] **Q6 — NEEDS_REVIEW resolution path.** RESOLVED → prior-auth missing is now a clean `DENIED`, so it no longer routes to `NEEDS_REVIEW`. `NEEDS_REVIEW` is reached **only** via a dispute reopen and clears by immediate auto re-adjudication. No human-review state in v1.
- [ ] **Q4 — Dispute resolution.** Auto re-adjudicate vs. reviewer queue. Leaning auto, original preserved immutably. (C6 — does not block adjudication TDD cycles 1–25; confirm before cycle 27.)

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
| 8 | 2026-06-18 | Reimbursement model (plan → member); PAID via explicit settle action, gateway success assumed | Brief says "claims for reimbursement" and lists `paid` in the lifecycle. No real payment processing in scope → record the transition. Likely a 5th interface action. | **PAID/settle deferred to v2 — see #19** |
| 9 | 2026-06-18 | Member = opaque `member_id` anchor; PII minimized/separated, encryption-at-rest candidate | Brief flags sensitive health data; engine adjudicates on `member_id → policy + accumulators` and never needs the name. One human persona (no auth/roles). | No |
| 10 | 2026-06-18 | `NEEDS_REVIEW` is a valid line state (locked); prior-auth *routing* to it is **PROVISIONAL** | State comes from infographic 04 + brief's "1 needs review". The *routing rule* is C3 adjudication behavior — confirmed in the C3 brainstorm, would revise #7. | **Superseded by #15** |
| 11 | 2026-06-18 | Capture `diagnosis_code` + `provider` on the Claim as encrypted, non-adjudicated PHI | Brief names them as sensitive data; capturing is where we *demonstrate* the PHI stance. Revises the earlier omit-lean (Fork #2). | No |
| 12 | 2026-06-18 | Claim + LineItem attributes locked; 12-code closed service catalog; `service_date` at claim level; `units` per line; Adjudication `reasons[]` array | Matches the infographics. Unlisted `service_code` → `NO_COVERAGE`. `reasons[]` array revises the single-dominant-code stance. | No |
| 13 | 2026-06-18 | C2 intake = N1–N5; reject = HTTP 4xx, never persisted (no `REJECTED` state); member-existence = intake reject, policy-active = adjudication deny | Industry reject≠deny boundary (Stedi: once adjudicated, can only be denied). A reject never enters the system. | No |
| 14 | 2026-06-18 | Accumulator carries `deductible_met_cents` + `oop_met_cents` + per-service `limit_used` | Infographic 02 omitted `deductible_met`; the deductible draw at adjudication needs it. | No |
| 15 | 2026-06-19 | Prior-auth missing → **clean DENY** (`PRIOR_AUTH_REQUIRED`, payable 0), not `NEEDS_REVIEW` | No reviewer queue in scope → `NEEDS_REVIEW` would freeze claims forever. A deny is deterministic + fully explainable. Supersedes #10; resolves Q6. | No |
| 16 | 2026-06-19 | Adjudication outcomes are **decisions (HTTP 200)**, not errors; only malformed/identity input is 4xx | A denial carries a reason + explanation (the brief's "explain why"); an HTTP error explains nothing and breaks the "1 denied line" scenario. | No |
| 17 | 2026-06-19 | `prior_auth_present` **defaults to `true`** on input (absence = auth present) | Most services need no auth → frictionless common input; denial fires only on explicit `false`. Documented demo simplification. | No |
| 18 | 2026-06-19 | **C3 adjudication behavior locked** → `docs/adjudication-plan.md` (pipeline, cost-share math, determinism, accumulator writeback, 27-step TDD order) | The "big open" item. Engine is now planned in enough detail to test-drive. Built with System-Architect + DBA agents grounded in the repo docs. | No |
| 19 | 2026-06-19 | **No `PAID` state / settle in v1** — claim lifecycle ends at APPROVED/PARTIALLY_APPROVED/DENIED; line items at APPROVED/DENIED/NEEDS_REVIEW; dispute reopens → UNDER_REVIEW | The payable *amount* is computed + explained; the PAID *state* needs a settle trigger + gateway (out of scope). Don't model a status we can't truthfully transition. `paid` deferred to v2. Supersedes the PAID half of #8. | No |
| 20 | 2026-06-19 | **Status-transition audit log** — one append-only polymorphic table via a `setStatus()` chokepoint (4 sites: submit/adjudicated/aggregated/dispute), surfaced on `GET /claims/:id`; not event-sourced | Strengthens lifecycle tracking (a named rubric signal) with ~2 functions; status columns stay source of truth; injected `seq` keeps re-runs deterministic. Adds TDD cycles 28–31. Designed with the System/Solution Architect. | No |

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
| 2026-06-19 | Claude Code (Opus) | 03-design | Reviewed framing trajectory (adversarial panel: direction good, was over-framing). Ran System-Architect + DBA agents to **lock C3 adjudication behavior** → wrote `docs/adjudication-plan.md` (pipeline + math + determinism + 27-step TDD order). Resolved prior-auth (clean DENY, #15), decision-vs-error boundary (#16), `prior_auth_present` default true (#17); closed Q6. Propagated across PRD, decisions, domain-model. | **Start TDD cycle 1 (`no rule → NO_COVERAGE`), test-first.** Confirm Q4 before cycle 27. Save this session's JSONL to `ai-artifacts/03-design/`. |
| 2026-06-19 | Claude Code (Opus) | 03-design | Strengthened lifecycle tracking: **dropped `PAID`/settle from v1** (#19) and locked a **status-transition audit log** (#20, designed with the System/Solution Architect) → TDD now 31 cycles. Propagated across PRD, decisions, domain-model, adjudication-plan, visual-reference. | **Detail the dispute events** (what a dispute writes + its re-adjudication transitions, Q4), then start TDD cycle 1. Save this session's JSONL to `ai-artifacts/03-design/`. |

## Notes for next agent

- Scaffold lives at the repo root (`/insurance`), not in a nested `claims-system/` — the
  existing `.git` is at the root, so the root *is* the project.
- `project-docs/` holds the original assignment brief. Reference it; do not edit it.
- Nothing in `app/` yet — first code must arrive via a `/tdd-cycle`, test first.
- **The adjudication build is fully specced in [`docs/adjudication-plan.md`](docs/adjudication-plan.md)** — the **31-cycle** TDD order is the coding checklist. Cycles 1–25 are pure (no DB); 26–31 touch SQLite (28–31 = the status-transition log).
- Load the `insurance-domain` + `tdd-discipline` skills before the first cycle.
- Per the assignment, this design session's raw JSONL must be saved into `ai-artifacts/03-design/` (use `/end-session`).
