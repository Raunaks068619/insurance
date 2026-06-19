# Decisions & trade-offs

> Status: template, pre-seeded from framing. Add a numbered entry whenever a real choice is
> made. Each entry: the decision, the alternative not taken, and the trade-off. This is the
> doc that shows engineering judgment — keep it honest.

## Format

`#N — Decision` → **Chose:** … **Over:** … **Trade-off:** … **Reversible?:** …

---

### 1 — Language and runtime: TypeScript (strict) + Node 20, vitest

**Chose:** TypeScript strict mode on Node 20, tested with vitest.
**Over:** plain JS, or Python/FastAPI.
**Trade-off:** Strict types add upfront friction but encode the domain (money as branded
cents, exhaustive reason-code switches) and catch a class of bugs at compile time. vitest
keeps the red-green loop fast.
**Reversible?:** Low cost early, high cost later.

### 2 — Persistence: SQLite (better-sqlite3) over Postgres

**Chose:** SQLite via better-sqlite3.
**Over:** Postgres / Docker-compose stack.
**Trade-off:** A reviewer clones and runs with zero DB setup, and the synchronous driver
keeps adjudication deterministic and easy to test. Cost: no real concurrency story; fine
for a demo, called out as a limitation in self-review.
**Reversible?:** Moderate — schema is portable; the synchronous-driver assumption is not.

### 3 — Rule representation: typed config over a DSL / rules engine

**Chose:** Coverage rules as typed config records, applied by a fixed-order adjudicator.
**Over:** A rules DSL or a pluggable rules engine.
**Trade-off:** Typed config is reviewable, type-checked, and enough for the rules in scope.
A DSL is meta-machinery the assignment explicitly does not reward and would eat the 48h
budget. Cost: adding a fundamentally new *kind* of rule means code, not config.
**Reversible?:** Yes — the adjudicator is the seam; a DSL could be layered later.

### 4 — Money: integer cents everywhere

**Chose:** All monetary values as integer cents; percentages applied with explicit rounding
at the cents step.
**Over:** Floating-point dollars, or a decimal library.
**Trade-off:** Integers make money math exact and tests trustworthy — float math on money
(coinsurance %, accumulation) is the most common claims bug. Cost: must round consciously
where coinsurance produces fractional cents (member + plan shares must sum to allowed).
**Reversible?:** Hard — touches every amount; chosen deliberately up front.

### 5 — Interface: REST API (fastify) over CLI or web UI

**Chose:** Four REST endpoints via fastify.
**Over:** CLI, or a web UI.
**Trade-off:** REST is the clearest way to demonstrate the domain to a reviewer and maps
1:1 to the operations (submit, fetch, explain, dispute). A UI would burn budget on
non-rubric surface. _Confirm this stands after framing._
**Reversible?:** Yes — the domain core is interface-agnostic.

### 6 — Cost-share: a discriminated union, not nullable copay + coinsurance fields

**Chose:** `costShare: { type: "full_coverage" } | { type: "copay"; copayCents } | { type: "coinsurance"; rate }` — one mechanism per rule.
**Over:** a flat record with both `copayCents` and `coinsuranceRate` applied in sequence.
**Trade-off:** Research across UHC, Aetna, Cigna, BCBS, and ACA showed real benefits use
*one* mechanism — preventive is full coverage, office/ER/urgent are copay, imaging/surgery/
hospital are coinsurance after deductible. A union makes the model *say* that, turns the
adjudicator into an exhaustive switch, and rejects incoherent rules at the type level. Cost:
the rare copay-then-coinsurance case (ER) is approximated by its dominant component.
**Reversible?:** Yes — a 4th union variant can be added; the adjudicator switch is the seam.

### 7 — Annual limit: unit-typed (`none` | `dollars` | `visits`), not dollars-only

**Chose:** `limit: { unit: "none" } | { unit: "dollars"; amountCents } | { unit: "visits"; count }`,
with the accumulator's `limit_used` tracked in the same unit.
**Over:** a single `annualLimitCents` field.
**Trade-off:** The brief's one concrete example ("$Y per year") is a dollar limit — but the
*most common* real limit is a visit/day cap (PT 20 visits/yr, SNF 60 days/yr), which a
cents-only field literally cannot express. The unit discriminator handles both on one code
path. Cost: the accumulator and limit check become unit-aware (small). This is a deliberate
step beyond the brief's literal ask, justified by domain research.
**Reversible?:** Moderate — touches the accumulator's limit column and the limit step.

### 8 — Prior-auth missing → clean DENY (RESOLVED in C3 brainstorm)

> **Status: RESOLVED** (C3 brainstorm, this session). Supersedes the earlier provisional
> `NEEDS_REVIEW` lean.

**Chose:** A prior-auth-required line with no auth present → a clean `DENIED` line carrying
`PRIOR_AUTH_REQUIRED`, payable 0, with an explanation. It is an adjudication **decision**
(HTTP 200), never an error.
**Over:** Routing it to `NEEDS_REVIEW` (the brief's *"1 needs review"* lean).
**Trade-off:** With no human-reviewer queue in scope, a `NEEDS_REVIEW` line would never
resolve and would freeze claim aggregation at `UNDER_REVIEW` forever. A clean deny is
deterministic and fully explainable — the brief's "explain why it was denied" is satisfied by
the reason code + sentence. Cost: we don't showcase a review-queue flow (out of scope anyway).
`NEEDS_REVIEW` survives as a state but is reached **only** via a dispute reopen, and clears by
immediate auto re-adjudication (Q4 lean). This resolves the old Q6.
**Reversible?:** Yes — prior-auth returns a single routing flag; swapping to `NEEDS_REVIEW`
is a one-line change if a queue is ever added.

### 9 — Capture `diagnosis_code` + `provider` as encrypted, non-adjudicated PHI

**Chose:** Capture `diagnosis_code` and `provider` on the Claim, store them as sensitive
(encryption-at-rest candidate), and **never** read them in adjudication.
**Over:** Omitting them entirely (the earlier research lean).
**Trade-off:** The brief explicitly names them as sensitive health data; capturing them is
where we *demonstrate* the PHI-handling the brief is testing. Cost: PHI we must protect for
zero math benefit — accepted deliberately, documented as the showcase of the PHI stance.
**Reversible?:** Yes — they're inert fields.

### 10 — Claim + LineItem shape, closed 12-code catalog, `reasons[]` array

**Chose:** Claim = `{ id, member_id, service_date (claim-level), provider, diagnosis_code,
status (derived) }`; LineItem = `{ id, claim_id, service_code, billed_cents, units,
prior_auth_present, status, fingerprint }`; a **closed 12-entry `service_code` catalog**;
Adjudication carries a `reasons[]` array.
**Over:** Per-line service dates; an open service vocabulary; a single dominant reason code.
**Trade-off:** Claim-level date + closed catalog keep v1 simple and make `NO_COVERAGE`
well-defined. `reasons[]` gives a richer EOB breakdown than one dominant code. Cost: can't
model a claim spanning multiple service dates (documented).
**Reversible?:** Moderate for the date; easy for the rest.

### 11 — C2 intake: reject = HTTP 4xx, never persisted (no `REJECTED` state)

**Chose:** Structural/identity failures (bad shape, non-integer cents, future/invalid date,
**unknown member**) → HTTP `4xx` with `{ errors: [{ field, code, message }] }`, nothing
persisted. Member *existence* is an intake reject; policy *active-on-date* is an
adjudication `POLICY_NOT_ACTIVE` deny.
**Over:** Persisting a `REJECTED` claim row for auditability.
**Trade-off:** Matches the industry reject≠deny boundary (a reject never enters the system,
no appeal) and avoids bloating the frozen claim state machine. Cost: no built-in audit trail
of bad submissions — if needed, log them separately, not as Claim rows.
**Reversible?:** Yes — a reject log can be added without touching the claim machine.

### 12 — Adjudication outcomes are decisions (HTTP 200), not errors

**Chose:** Every adjudication outcome — including all denials (`NO_COVERAGE`, `EXCLUDED`,
`PRIOR_AUTH_REQUIRED`, `LIMIT_EXCEEDED`, `POLICY_NOT_ACTIVE`, `DUPLICATE_LINE_ITEM`) — returns
HTTP `200` with `status` + `reason` + `explanation`. A denied line is a *processed* line.
Only malformed/identity-failed **input** is an HTTP `4xx` (the C2 intake reject, decision #11).
**Over:** Treating a business denial (e.g. prior-auth missing) as an HTTP error.
**Trade-off:** Errors explain nothing to a member and would break the brief's *"5 line items,
1 denied"* scenario and *"explain why it was denied."* A decision carries the explanation.
Cost: callers must read per-line status, not just the HTTP code — correct and intended.
**Reversible?:** N/A — this is the core contract of the engine.

### 13 — `prior_auth_present` defaults to `true` on input (absence = auth present)

**Chose:** When a line item omits `prior_auth_present`, treat it as `true`. The
`PRIOR_AUTH_REQUIRED` denial path fires only on an explicit `false`.
**Over:** Defaulting to `false` (absence = no auth).
**Trade-off:** Most services don't require prior auth, so a `true` default keeps the common
input frictionless; callers assert `false` only when relevant. Cost: a caller who forgets to
send `false` for an auth-required service is assumed to have had auth — an accepted demo
simplification, documented here. (Real systems treat absence as unauthorized.)
**Reversible?:** Yes — a one-line default change.

---

## Decisions resolved this framing session

- **Prior-auth modeling** (Q1) — boolean precondition; missing → `PRIOR_AUTH_REQUIRED`, payable 0. PPO reduce-to-50% penalty documented as a divergence, not built.
- **Out-of-network** (Q2) — in-network only for v1 (allowed == billed); OON/unlisted service → `NO_COVERAGE`. Network/metal/family fields omitted.
- **Accumulator period** (Q3) — fixed plan-year window keyed on the policy.

## Decisions still open (resolve and move up)

- **Dispute resolution (Q4)** — auto re-adjudicate vs. reviewer queue (leaning auto, immutable
  original). C6 — does not block core adjudication TDD (cycles 1–25); confirm before cycle 27.

## Decisions resolved (moved up)

- **Duplicate handling (Q5)** — RESOLVED: fingerprint computed at intake; soft `DUPLICATE_LINE_ITEM` decided at adjudication. See decision #11 / TRACK #12.
- **C3 adjudication behavior** — RESOLVED (this session): full pipeline, cost-share math,
  determinism, accumulator writeback, and the TDD build order are planned in
  [`docs/adjudication-plan.md`](adjudication-plan.md). Ready to test-drive.
- **Prior-auth routing (was Q6 / decision #8)** — RESOLVED: clean DENY, not `NEEDS_REVIEW`.
  See decision #8.

## Assumptions about the domain

1. Single currency (USD), integer cents.
2. One policy per member per plan year; no coordination of benefits.
3. Allowed amount == billed amount (no fee schedule lookup).
4. Plan year is a fixed window on the policy; accumulators align to it.
5. Prior auth is a recorded precondition, not a workflow.
6. Determinism over wall-clock; concurrency beyond SQLite's single-writer is out of scope.
7. One cost-share mechanism per service; copay-then-coinsurance approximated by dominant component.
8. Limits are unit-typed (`dollars` or `visits`); supply-window/replacement-frequency limits out of scope.
9. `prior_auth_present` defaults to `true` on input (absence = auth present); denial fires only on explicit `false`.
10. Adjudication denials are decisions (HTTP 200 + reason + explanation); only malformed/identity input is HTTP 4xx.

_Add to this list whenever the build forces a judgment call the assignment left open._
