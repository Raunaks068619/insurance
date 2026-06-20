# TRACK.md — live cross-session memory

The only file that mutates freely. Every agent updates it at session close. Keep it
honest and current — the next agent trusts it instead of re-deriving everything.

## Current focus

**Latest (2026-06-20, Opus 4.8) — run-the-API review → prior-auth FAIL-CLOSED + intake hardening.**
A live API probe (server up, all 3 endpoints exercised with happy-path + adversarial inputs) surfaced a
money-leaking bug: a `mem_prior_auth` MRI with `priorAuthPresent` **omitted** was being APPROVED and
paid — `prior_auth_present` defaulted to `true` (absence = present), contradicting the seed's own demo
(`DENIED PRIOR_AUTH_REQUIRED`) and the Q1 framing. Fixed **fail-closed** (default `false`) at all three
layers — `schema.sql` `DEFAULT 0`, `schema.ts` `.default(false)`, repo `?? false` — test-first
(`app/tests/prior-auth-default.test.ts`, red→green: omitted/explicit-false DENY, explicit-true APPROVES).
Also hardened intake: (1) `billedCents` + `corrected.billedCents` gained `maximum` = `MAX_BILLED_CENTS`
(`10_000_000_000` ¢ = $100M) so out-of-range amounts are a **400 intake reject** (mirror of `minimum:1`),
not a 500 and not a denial (`app/tests/http-submit-validation.test.ts`); (2) the central error handler
fails closed — unexpected 5xx now returns generic `{code:"INTERNAL_ERROR"}` instead of leaking the
underlying message/DB internals (`app/tests/http-error-handler.test.ts`). **78/78 green**, `tsc` clean,
biome clean on touched files (one PRE-EXISTING nit remains in `seed.ts:292`, untouched). Logged decision
**#22** (reverses #13); propagated to `decisions.md` (assumption #9), `erd-physical.md`, `README.md`
(Flow 2 now omits the field, new Flow 10, intake note). **Not yet committed.** Auth/authz still out of
scope by design (documented assumption, not a regression).

**Latest (2026-06-20, Opus 4.8) — duplicate-detection gap CLOSED.** The last self-review #1 gap is
fixed: `claimService.adjudicateClaim` no longer hardcodes `alreadyAdjudicated: false` — it now calls
`adjudicationRepository.existsForFingerprint(fingerprint, line.id)`, so a resubmitted identical line
is denied `DUPLICATE_LINE_ITEM` (cross-claim **and** within one batch). New
`app/tests/duplicate-line.test.ts` (3 cases); **65/65 green**, committed (`540fde3`). The pure core,
the HTTP/API layer, seed data, and disputes are all built and committed. (The historical narrative
below predates the HTTP layer — see the session log + decision #29 for the current trail.)

**Phase `04-coding` (TDD) — the entire pure core is done.** Cycles **1–25 complete and green**
(25 tests; working tree clean at `a11c081`):

- **1–21 — `adjudicateLine`** (pure): gates (no-coverage / excluded / not-covered /
  policy-not-active / prior-auth / duplicate), cost-share math (full / copay / coinsurance +
  deductible draw + half-up rounding), limits (visit cap + dollar straddle), OOP cap, and
  cross-line determinism (line 2 sees line 1's deltas; re-run is identical).
- **22–25 — `aggregateClaimStatus`** (pure): all-approved → `APPROVED`, all-denied → `DENIED`,
  mixed / straddle → `PARTIALLY_APPROVED`. Added the `ClaimStatus` type + a minimal
  `LineOutcome`; the `UNDER_REVIEW` branch is deliberately deferred to the dispute cycles (#24).

**ALL 36 cycles DONE (uncommitted) — the full TDD plan is complete.** Physical schema locked in
[`docs/erd-physical.md`](docs/erd-physical.md); the whole engine is implemented test-first on it:
- **Scaffolding (`chore:`):** deps (`better-sqlite3` + `drizzle-orm`), `app/src/db/schema.sql`
  (canonical DDL from the ERD), `createDb(':memory:')` factory + `applySchema`, Drizzle `schema.ts`
  (mirror), repo/service DI skeletons (**service → repositories → db**), schema smoke test.
- **26 writeback (`feat:`):** `claimService.adjudicateClaim` — resolve policy+rules → persist →
  adjudicate each line (reusing pure `adjudicateLine`) → append decisions → advance accumulators →
  aggregate → **one transaction**.
- **27–31 transition log:** one `setStatus()` chokepoint (status column + transition row in one write)
  + per-claim `seq` clock; two-phase `adjudicateClaim` logs submit→adjudicate→aggregate; disputes log
  the reopen + re-adjudication.
- **27 + 32–36 disputes:** `disputeService.open` re-adjudicates corrected facts with the accumulator
  **net-out** (`current − original deltas`), appends a new decision (original preserved), resolves the
  4-value outcome, and guards via a `DisputeError` (404 / 409).
- ⚠️ **TDD caught a real ERD bug:** `GLOB '____-__-__'` used LIKE-style `_` (a literal in GLOB) →
  rejected every date; fixed at source (`[0-9]` classes) + re-extracted `schema.sql` (#26).

**46/46 green** (36/36 cycles), `tsc` + full `pnpm lint` clean. **Next is NOT a cycle — the HTTP/API
layer** (submit, `GET /claims/:id` with `timeline`+`disputes[]`, dispute endpoint), seed data, a
run-through. (Housekeeping: regenerate the 3 stale infographics.)

## Current phase

`04-coding` (TDD) — **cycles 1–36 DONE** (1–25 committed `a11c081`; scaffolding + 26–36 + GLOB fix + format uncommitted). The 36-cycle TDD plan is complete; next is the HTTP/API layer (not a cycle).

## Open questions

- [x] **Q1 — Prior auth modeling.** RESOLVED → boolean precondition; missing → `PRIOR_AUTH_REQUIRED`, payable 0. PPO reduce-to-50% penalty documented as a divergence, not built.
- [x] **Q2 — Out-of-network policy.** RESOLVED → in-network only for v1 (allowed == billed); OON/unlisted service → `NO_COVERAGE`. Network/metal-tier/family fields omitted (no math impact).
- [x] **Q3 — Accumulator period boundaries.** RESOLVED → fixed plan-year window keyed on the policy.
- [x] **Q5 — Duplicate handling.** RESOLVED → fingerprint (`member_id + service_code + service_date + billed_cents`) computed at **intake**; the duplicate *decision* is made at **adjudication** as a soft `DUPLICATE_LINE_ITEM` (payable 0). Not an intake reject.
- [x] **Q6 — NEEDS_REVIEW resolution path.** RESOLVED → prior-auth missing is now a clean `DENIED`, so it no longer routes to `NEEDS_REVIEW`. `NEEDS_REVIEW` is reached **only** via a dispute reopen and clears by immediate auto re-adjudication. No human-review state in v1.
- [x] **Q4 — Dispute resolution.** RESOLVED → first-class corrected-facts re-adjudication (decisions #21–#23): disputable from any terminal line, single-line accumulator net-out (`current − this line's original deltas`), 4-value outcome (`UPHELD | OVERTURNED | PARTIALLY_OVERTURNED | MODIFIED`), original preserved immutably, no reviewer queue.

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
| 17 | 2026-06-19 | ~~`prior_auth_present` **defaults to `true`** on input (absence = auth present)~~ **REVERSED by #22 → defaults to `false` (fail-closed)** | Original rationale: frictionless common input. Reversed 2026-06-20: a `true` default silently bypasses a financial control (an omitted field = auto-authorized). | **Yes → #22** |
| 18 | 2026-06-19 | **C3 adjudication behavior locked** → `docs/adjudication-plan.md` (pipeline, cost-share math, determinism, accumulator writeback, 27-step TDD order) | The "big open" item. Engine is now planned in enough detail to test-drive. Built with System-Architect + DBA agents grounded in the repo docs. | No |
| 19 | 2026-06-19 | **No `PAID` state / settle in v1** — claim lifecycle ends at APPROVED/PARTIALLY_APPROVED/DENIED; line items at APPROVED/DENIED/NEEDS_REVIEW; dispute reopens → UNDER_REVIEW | The payable *amount* is computed + explained; the PAID *state* needs a settle trigger + gateway (out of scope). Don't model a status we can't truthfully transition. `paid` deferred to v2. Supersedes the PAID half of #8. | No |
| 20 | 2026-06-19 | **Status-transition audit log** — one append-only polymorphic table via a `setStatus()` chokepoint (4 sites: submit/adjudicated/aggregated/dispute), surfaced on `GET /claims/:id`; not event-sourced | Strengthens lifecycle tracking (a named rubric signal) with ~2 functions; status columns stay source of truth; injected `seq` keeps re-runs deterministic. Adds TDD cycles 28–31. Designed with the System/Solution Architect. | No |
| 21 | 2026-06-19 | **Dispute trigger = corrected member facts + current-rule binding** (`corrected{prior_auth_present?, service_code?, billed_cents?, units?}`); no corrected facts → `UPHELD`; no reviewer override | A deterministic engine re-running identical inputs is a no-op; a meaningful flip needs a changed input. Binding to current rules also covers retroactive rule changes. No reviewer actor in scope. Resolves Q4. | No |
| 22 | 2026-06-19 | **Disputable from any terminal line** (APPROVED/partial/DENIED); **single-line re-adjudication with accumulator net-out** (`current − this line's original deltas`); no sibling/cross-claim cascade | Members dispute underpayments too. Blind delta-reversal corrupts shared accumulators; net-out keeps the invariant (each dimension = Σ of every line's *latest* deltas). Cascade out of scope (documented). Corrects adjudication-plan's old "reverse deltas" wording. | No |
| 23 | 2026-06-19 | **4-value dispute outcome** `UPHELD\|OVERTURNED\|PARTIALLY_OVERTURNED\|MODIFIED` (diff new vs original); line `*→NEEDS_REVIEW→{APPROVED\|DENIED}`; dispute `OPEN→RESOLVED`; `DISPUTED_OVERRIDE` unused (v2 slot) | Deterministic + testable; keeps the locked `NEEDS_REVIEW` name; UPHELD surfaced honestly so a no-change dispute isn't mistaken for broken. Adds TDD cycles 32–36. Confirmed with the user after a 3-agent stress-test. | No |
| 24 | 2026-06-19 | **Claim aggregation implemented (cycles 22–25).** A *straddle* = an `APPROVED` line whose `reasons` include `LIMIT_EXCEEDED` → claim `PARTIALLY_APPROVED`; the aggregator reads a minimal `LineOutcome {status, reasons}`; `PARTIALLY_APPROVED` stays claim-level-only; `UNDER_REVIEW` (any `NEEDS_REVIEW` line) deferred to the dispute cycles | Detects a partial payout from the reason code already emitted on a straddle — no new partial *line* state, keeping the locked line/claim split (#14/#19). Minimal `LineOutcome` decouples the pure aggregator from the persistence/result shape. `UNDER_REVIEW` has no triggering test until disputes (TDD minimalism). See decisions.md #17. | No |
| 25 | 2026-06-20 | **SQLite layer scaffolded (`chore:`).** `schema.sql` (extracted **verbatim** from `docs/erd-physical.md`) is the **canonical DDL**; `schema.ts` Drizzle handles **mirror** it for typed queries (no `drizzle-kit generate`). `createDb(path=':memory:')` factory → isolated in-memory DB per test. Layering **service → repositories → db** (services hold workflows; repositories own the `Db`). `updated_at` enforced by DB touch-triggers. | Faithful to the reviewed ERD (triggers/CHECKs/composite-FKs Drizzle can't all express); dual-source (SQL canonical + Drizzle mirror) accepted + documented. `:memory:` factory satisfies tdd-discipline "no shared state between tests". A service reaching the raw `Db` was a layering slip, corrected this session. See decisions.md #18. | No |
| 26 | 2026-06-20 | **Cycle 26 writeback implemented (`feat:`) + ERD GLOB bug fixed.** Single `claimService.adjudicateClaim(input)` (submit + adjudicate + aggregate + persist in **one transaction** via an injected `withTransaction` runner). Real methods on all 5 repos; accumulator rows created **lazily** (only touched dimensions); first decision is `seq=1`. The ERD date guard `GLOB '____-__-__'` used LIKE-style `_` (literal in GLOB) → rejected every date; corrected to `[0-9]` digit classes at source + re-extracted `schema.sql`. | Single entrypoint chosen by the user (simplest for writeback). Lazy rows match the plan's "created on first use". The GLOB bug was invisible to the smoke test (no inserts) — surfaced the moment cycle 26 inserted a policy; TDD working as intended. Duplicate-detection (`alreadyAdjudicated`) is still hardcoded `false` (no triggering DB test yet). See decisions.md #19. | No |
| 27 | 2026-06-20 | **Status-transition log implemented (cycles 27–31).** One `setStatus()` chokepoint updates the status column AND appends a transition row in the same write; `seq` is a per-claim logical clock (`claims.bumpClaimSeq`). `adjudicateClaim` refactored to two phases (submit-all → adjudicate-all) for a clean SUBMIT→ADJUDICATED→AGGREGATED ordered log; disputes log the reopen (DENIED→NEEDS_REVIEW, MEMBER) + auto re-adjudication. | Implements decision #20's design. Two-phase ordering makes the merged timeline read naturally. Per-claim `seq` (not global) keeps re-runs deterministic — cycle 30 compares rows modulo ids + created_at. See decisions.md #20. | No |
| 28 | 2026-06-20 | **Dispute flow implemented (cycles 27, 32–36).** `disputeService.open` re-adjudicates corrected facts against current rules + the accumulator **net-out** (`current − this line's original deltas`, written back so each dimension = Σ of every line's *latest* deltas — no double-count); appends a new decision (original immutable); resolves the **4-value outcome** (diff new vs original); guards via a `DisputeError` (missing line → `NOT_FOUND`/404, non-terminal line → `CONFLICT`/409). | Implements decisions #16/#21–#23. Net-out is the crux — a blind reversal corrupts shared accumulators. Guards are **domain errors (4xx)**, mapped to HTTP at the controller (decision-vs-error boundary, #16). **All 36 cycles green (46 tests).** See decisions.md #21. | No |
| 29 | 2026-06-20 | **Duplicate-detection gap closed (test-first).** `adjudicationRepository.existsForFingerprint(fingerprint, excludeLineItemId)` (`COUNT(*)` over `adjudications ⋈ line_items`) now feeds `alreadyAdjudicated` in `claimService.adjudicateClaim`, replacing the hardcoded `false`. A resubmitted identical line (same `member\|service\|date\|billed` fingerprint) is denied `DUPLICATE_LINE_ITEM` — across claims **and** within one batch (the adjudications JOIN means only already-DECIDED siblings count, so the first occurrence still pays). New `app/tests/duplicate-line.test.ts` (3 cases) proves it; **65/65 green**. Supersedes the "still hardcoded false" note in #26. | The pure path + fingerprint storage already existed; only the DB query was missing (self-review's #1 gap). Dispute re-adjudication left on `false` by design — re-deciding the same line isn't a duplicate. | No |

## Domain research findings (2026-06-18)

Source: 6-agent web research across UnitedHealthcare, Aetna, Cigna, BCBS SBCs + ACA/CMS;
synthesis in `JSONL_session_logs/02-domain-research/`. Key findings that shaped the model:

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
| 2026-06-19 | Claude Code (Opus) | 03-design | Reviewed framing trajectory (adversarial panel: direction good, was over-framing). Ran System-Architect + DBA agents to **lock C3 adjudication behavior** → wrote `docs/adjudication-plan.md` (pipeline + math + determinism + 27-step TDD order). Resolved prior-auth (clean DENY, #15), decision-vs-error boundary (#16), `prior_auth_present` default true (#17); closed Q6. Propagated across PRD, decisions, domain-model. | **Start TDD cycle 1 (`no rule → NO_COVERAGE`), test-first.** Confirm Q4 before cycle 27. Save this session's JSONL to `JSONL_session_logs/03-design/`. |
| 2026-06-19 | Claude Code (Opus) | 03-design | Strengthened lifecycle tracking: **dropped `PAID`/settle from v1** (#19) and locked a **status-transition audit log** (#20, designed with the System/Solution Architect) → TDD now 31 cycles. Propagated across PRD, decisions, domain-model, adjudication-plan, visual-reference. | **Detail the dispute events** (what a dispute writes + its re-adjudication transitions, Q4), then start TDD cycle 1. Save this session's JSONL to `JSONL_session_logs/03-design/`. |
| 2026-06-19 | Claude Code (Opus) | 03-design | **Closed Q4 — dispute made first-class.** Ran 3 agents (repo audit + domain research + architecture stress-test); surfaced the determinism no-op + the accumulator delta-reversal bug; user confirmed 4 forks. Locked #21–#23; fixed the "reverse deltas" wording → net-out; added dispute spec + cycles 32–36 to adjudication-plan; propagated to decisions (#16). | **Start TDD cycle 1 (`no rule → NO_COVERAGE`), test-first.** Propagate dispute to domain-model + insurance-domain skill. Save this session's JSONL to `JSONL_session_logs/03-design/`. |
| 2026-06-19 | Claude Code (Opus) | 04-coding | **Implemented claim aggregation (cycles 22–25), test-first** → `aggregateClaimStatus` (all-approved / all-denied / mixed / straddle) + `ClaimStatus` type + `LineOutcome`; **25/25 tests green**, `tsc` + `biome` clean, committed `a11c081`. Corrected a stale assumption that 23–27 were "already done" — only 1–21 were. **Validated the DB scaffolding plan** (9 tables + 6 design calls + a `createDb(':memory:')` factory). Logged decision #24 / decisions.md #17. | **Scaffold the SQLite layer** (schema + connection factory + repo/service skeletons — `chore:`, no behavior), then TDD cycles 26–27 (writeback), test-first. |
| 2026-06-20 | Claude Code (Opus) | 04-coding | **Reconciled the DB design + scaffolded the SQLite layer (`chore:`, no behavior).** Audited the napkin "9 tables" vs `docs/erd-physical.md` (ERD wins: unions = typed columns not JSON, UUID ids); pruned-then-restored the `created_at`/`updated_at` columns (kept for audit) + added `updated_at` touch-triggers. Installed `better-sqlite3`/`drizzle-orm` (+ approved the native build); built `schema.sql` (canonical, from the ERD), `createDb(':memory:')` factory, `applySchema`, Drizzle `schema.ts`, repo/service DI skeletons (fixed a service→`Db` layering slip → service depends on **repositories**), and a schema smoke test. **28/28 green**, `tsc` + `biome` clean (new files). Logged decision #25 / decisions.md #18. | **Commit the `chore:` scaffolding**, then start TDD **cycle 26** (full claim persists → append-only, one txn), test-first. (Pre-existing biome drift in 5 committed files is unrelated — offer a separate `chore: format`.) |
| 2026-06-20 | Claude Code (Opus) | 04-coding | **Cycle 26 (full-claim writeback) — red→green, test-first.** Built the writeback chain: `db-helpers` (freshDb / seedWorld / makeClaimService), real methods on policy/coverage-rule/claim/adjudication/accumulator repos, and `claimService.adjudicateClaim` (resolve policy+rules → persist → adjudicate each line → append decisions → advance accumulators → aggregate → one txn). 4 assertions: persist, accumulator, append-only, txn-rollback. **TDD caught + fixed a real ERD bug** (`GLOB '____-__-__'` — LIKE `_` vs literal-in-GLOB) → fixed source + re-extracted `schema.sql`. **32/32 green**, `tsc` + `biome` clean. Logged decision #26 / decisions.md #19. | **Cycle 27** (dispute reopen preserves original), test-first. Then 28–31 (transition log), 32–36 (dispute outcomes). Consider committing scaffolding + cycle 26 + the GLOB `fix:`. |
| 2026-06-20 | Claude Code (Opus) | 04-coding | **Completed cycles 27–36 — the full 36-cycle TDD plan is DONE.** 27 (dispute reopen preserves original), 28–31 (status-transition log: a `setStatus()` chokepoint + two-phase `adjudicateClaim` + per-claim `seq` clock + dispute reopen logging), 32–36 (dispute outcomes OVERTURNED/UPHELD/MODIFIED/PARTIALLY_OVERTURNED, the accumulator **net-out** invariant, and `DisputeError` 404/409 guards). **46/46 green** (36/36 cycles), `tsc` + full `pnpm lint` clean (the pre-existing biome drift is fixed too). Logged decisions #27–#28 / decisions.md #20–#21. | **Not a cycle — the HTTP/API layer** (submit claim, `GET /claims/:id` with `timeline`+`disputes[]`+`adjudication_history`, the dispute endpoint), seed data, a live run-through. **Commit the full batch.** |
| 2026-06-20 | Claude Code (Opus 4.8) | 04-coding | **Closed the duplicate-detection gap (self-review #1), test-first.** Added `adjudicationRepository.existsForFingerprint` and wired it into `claimService.adjudicateClaim` (was `alreadyAdjudicated: false`); a resubmitted identical line is now denied `DUPLICATE_LINE_ITEM`. New `app/tests/duplicate-line.test.ts` (cross-claim + within-claim + distinct-not-flagged). **65/65 green**, `tsc` + biome clean (touched files); committed `540fde3`. Logged decision #29; refreshed `docs/self-review.md`. | Optional: HTTP-level dup test (`POST /claims` twice). Dispute path still on `alreadyAdjudicated: false` by design — confirm/document if desired. |
| 2026-06-20 | Claude Code (Opus 4.8) | 04-coding | **Run-the-API review → fixed prior-auth fail-open + hardened intake, test-first.** Live-probed all 3 endpoints; found `priorAuthPresent` defaulting to `true` silently approved+paid prior-auth claims. Reversed to **fail-closed** (`false`) across `schema.sql`/`schema.ts`/repo (`app/tests/prior-auth-default.test.ts`, red→green). Added `MAX_BILLED_CENTS` cap → out-of-range `billedCents`/`corrected.billedCents` is a 400 intake reject (was a silent pay / 500 leak); central error handler now returns generic `INTERNAL_ERROR` for 5xx (no DB-internal leak). **78/78 green**, `tsc` + biome clean (touched). Logged decision **#22** (reverses #13); updated decisions/erd/README. | **Commit the batch** (`fix:` prior-auth + `feat:`/`fix:` intake hardening). Pre-existing biome nit in `seed.ts:292` (template-literal) is unrelated — fix in a separate `chore:` if desired. Consider capping `units` (same overflow class) and validating real calendar dates (`2026-02-31` currently accepted). Auth/authz still out of scope. |

## Notes for next agent

- Scaffold lives at the repo root (`/insurance`), not in a nested `claims-system/` — the
  existing `.git` is at the root, so the root *is* the project.
- `project-docs/` holds the original assignment brief. Reference it; do not edit it.
- **Everything is committed through `540fde3` (HEAD)** — the narrative above (pure core at `a11c081`,
  "next is the HTTP layer") is historical. Now built + committed: the pure core, the SQLite layer,
  cycles **26–36** (writeback · status-transition log · first-class disputes), the **HTTP/API layer**
  (submit claim, `GET /claims/:id` with `timeline` + `disputes[]` + `adjudication_history`, the dispute
  endpoint via `disputeService.open` → `DisputeError` 404/409), seed data, and the **duplicate-detection
  fix** (decision #29). **65/65 green**, `tsc` + biome clean. The v1 engine is feature-complete; no TDD
  cycle is pending. (Only untracked: local `claims.db*` SQLite files — runtime artifacts.)
- **DB test pattern:** open a fresh `createDb(':memory:')` → `applySchema(sqlite)` → run → `sqlite.close()`; one isolated in-memory DB per test. Wire a service with `makeClaimService({db, sqlite})`; seed reference data with `seedWorld(db, …)` (`app/tests/db-helpers.ts`).
- **Repos + services (all wired):** policy/coverage-rule/claim/adjudication/accumulator/dispute/status-transition repos; `claimService.adjudicateClaim`, `disputeService.open`, the `setStatus()` chokepoint. Services depend on repositories, never the raw `Db`.
- **The adjudication build is fully specced in [`docs/adjudication-plan.md`](docs/adjudication-plan.md)** — the **36-cycle** TDD order is the coding checklist. **Cycles 1–36 ✅ ALL DONE** (1–25 pure; 26 writeback; 27 + 32–36 disputes; 28–31 status-transition log).
- Load the `insurance-domain` + `tdd-discipline` skills before the first cycle.
- Per the assignment, this design session's raw JSONL must be saved into `JSONL_session_logs/03-design/` (use `/end-session`).
