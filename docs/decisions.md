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

---

## Decisions resolved this framing session

- **Prior-auth modeling** (Q1) — boolean precondition; missing → `PRIOR_AUTH_REQUIRED`, payable 0. PPO reduce-to-50% penalty documented as a divergence, not built.
- **Out-of-network** (Q2) — in-network only for v1 (allowed == billed); OON/unlisted service → `NO_COVERAGE`. Network/metal/family fields omitted.
- **Accumulator period** (Q3) — fixed plan-year window keyed on the policy.

## Decisions still open (resolve and move up)

- **Dispute resolution** — auto re-adjudicate vs. reviewer queue (leaning auto, immutable original).
- **Duplicate handling** — hard reject vs. soft duplicate flag (leaning soft flag, `DUPLICATE_LINE_ITEM`).

## Assumptions about the domain

1. Single currency (USD), integer cents.
2. One policy per member per plan year; no coordination of benefits.
3. Allowed amount == billed amount (no fee schedule lookup).
4. Plan year is a fixed window on the policy; accumulators align to it.
5. Prior auth is a recorded precondition, not a workflow.
6. Determinism over wall-clock; concurrency beyond SQLite's single-writer is out of scope.
7. One cost-share mechanism per service; copay-then-coinsurance approximated by dominant component.
8. Limits are unit-typed (`dollars` or `visits`); supply-window/replacement-frequency limits out of scope.

_Add to this list whenever the build forces a judgment call the assignment left open._
