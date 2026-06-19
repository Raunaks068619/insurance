# Adjudication plan (C3) — the engine's behavior

> The reference for the coding phase. This is the *how* of adjudication: the per-line-item
> function, the ordered pipeline, the cost-share math, accumulator writeback, and the
> test-drive order. Shapes it reads/writes (Claim, LineItem, CoverageRule, Accumulator) are
> locked in `domain-model.md` / `PRD.md`. If this doc and the code drift, the code wins and
> this gets updated.

## The core is a pure function

Adjudication is `(line item, policy, matching rule, accumulator snapshot) → decision + deltas`.
No I/O in the core: it reads a **snapshot** of the accumulator and returns the **deltas** to
apply. The caller (a service) applies deltas and persists. This is what makes the engine
deterministic and unit-testable with a plain object — no DB needed for tests 1–25.

```ts
function adjudicateLine(input: AdjudicateInput): AdjudicateResult;

type AdjudicateInput = {
  line: LineItem;                  // service_code, billed_cents, units, prior_auth_present
  policy: Policy;                  // effective/termination, deductible_cents, oop_max_cents
  rule: CoverageRule | undefined;  // matched by service_code; undefined → NO_COVERAGE
  serviceDate: string;             // claim-level ISO date (policy-active check)
  acc: AccumulatorSnapshot;        // read-only snapshot taken at claim start
  alreadyAdjudicatedFingerprint: boolean; // true → DUPLICATE_LINE_ITEM
};

type AccumulatorSnapshot = {
  deductible_met_cents: number;
  oop_met_cents: number;
  limit_used: number;              // per rule unit: cents for dollars, count for visits
};

type AdjudicateResult = {
  status: LineItemStatus;              // APPROVED | DENIED
  payable_cents: number;               // plan pays
  member_responsibility_cents: number; // member owes
  reasons: ReasonCode[];               // dominant code first; breakdown follows
  explanation: string;                 // EOB sentence citing rule + numbers
  deltas: { deductible_inc_cents: number; oop_inc_cents: number; limit_inc: number };
};
```

**Invariant (every covered line):** `payable_cents + member_responsibility_cents === billed_cents`
(allowed == billed in v1). On a denial, both are 0.

## The ordered pipeline — gates then math

Walk per line item, **short-circuit at the first failed gate**.

| # | Step | Condition | On fail | Kind |
|---|------|-----------|---------|------|
| 0 | Duplicate | fingerprint not already adjudicated | `DUPLICATE_LINE_ITEM`, payable 0 | GATE |
| 1 | Policy active | `effective ≤ serviceDate ≤ termination` | `POLICY_NOT_ACTIVE`, payable 0 | GATE |
| 2 | Rule exists | rule found for `service_code` | `NO_COVERAGE`, payable 0 | GATE |
| 3 | Covered / not excluded | `!excluded && covered` | `excluded`→`EXCLUDED`; else `NO_COVERAGE` | GATE |
| 4 | Prior auth | `!requires_prior_auth \|\| prior_auth_present` | `PRIOR_AUTH_REQUIRED`, payable 0, **clean DENY** | GATE |
| 5 | Limit remaining | `none`→skip · `visits`: used < count · `dollars`: used < amount | `LIMIT_EXCEEDED`, payable 0 | GATE |
| 6 | Compute allowed | `allowed = billed` (v1) | — | MATH |
| 7 | Cost-share switch | switch on `cost_share.type` (below) | — | MATH |
| 7b | Dollar-limit straddle | only `dollars` + plan pay would exceed remaining | cap plan pay; shortfall→member, `LIMIT_EXCEEDED` on portion; line stays `APPROVED` | MATH |
| 8 | OOP cap | member share would pass `oop_max` → refund excess to plan | `OOP_MAX_REACHED`; member never exceeds cap | MATH |
| 9 | Build deltas | deductible / oop / limit increments | — | MATH |

## The cost-share switch (step 7)

`allowed = billed`. The deductible is touched **only** by coinsurance.

| `cost_share.type` | Deductible | Member owes | Plan pays | Reasons |
|---|---|---|---|---|
| `full_coverage` | untouched | 0 | allowed | `[APPROVED]` |
| `copay` | **waived**; copay accrues to OOP only | `min(copay_cents, allowed)` | allowed − member | `[APPROVED, COPAY_APPLIED]` |
| `coinsurance` | **applied first** (if `applies_deductible`) | dedPortion + coinsPortion | allowed − member | `[APPROVED, DEDUCTIBLE_APPLIED?, COINSURANCE_APPLIED]` |

**Coinsurance math (the only non-trivial branch):**
```
remainingDeductible = max(0, deductible_cents − deductible_met_cents)
dedPortion  = applies_deductible ? min(remainingDeductible, allowed) : 0   // member; accrues to deductible
remainder   = allowed − dedPortion
coinsPortion = Math.round(rate * remainder)                                // member share; round half-up
member = dedPortion + coinsPortion
plan   = allowed − member          // computed last → shares always sum to allowed, no lost cent
```
Rounding lives only on `coinsPortion`; `plan = allowed − member` guarantees the sum.

## Line items → claim status (derived, never set directly)

| Line outcomes | Claim status |
|---|---|
| every line `DENIED` | `DENIED` |
| every line `APPROVED` (full payable) | `APPROVED` |
| mix of `APPROVED` + `DENIED`, or any dollar-straddle partial | `PARTIALLY_APPROVED` |
| any line `NEEDS_REVIEW` / disputed re-adjudicating | `UNDER_REVIEW` |
| every payable line `PAID`, none open | `PAID` |

`PARTIALLY_APPROVED` is **claim-level only** — never a line state. A straddled line is itself
`APPROVED` (partial payable) with a `LIMIT_EXCEEDED` note.

## Decisions vs errors (the boundary)

- **Adjudication outcomes are decisions** → HTTP **200**, with `status`, `reason`, and an
  `explanation`. This includes every denial: `NO_COVERAGE`, `EXCLUDED`, `PRIOR_AUTH_REQUIRED`,
  `LIMIT_EXCEEDED`, `POLICY_NOT_ACTIVE`, `DUPLICATE_LINE_ITEM`. A denied line is a *processed*
  line, not a failure.
- **Malformed / identity-failed input is an error** → HTTP **4xx** at intake (C2), nothing
  persisted. (Bad shape, non-integer cents, future date, unknown member.)
- **Prior-auth missing is a decision, not an error** → 200 + a `DENIED` line carrying
  `PRIOR_AUTH_REQUIRED` and an explanation. `prior_auth_present` defaults to `true` on input
  (absence = auth present); the denial path is triggered only by an explicit `false`.

## Determinism (snapshot-then-writeback)

1. **Snapshot** accumulators once at claim start into an in-memory working copy.
2. Process line items in a **stable order** (line id / array order).
3. Each line reads the working copy, returns `deltas`; the caller applies them **before** the
   next line — so line 2 sees line 1's deductible draw (correct cross-line behavior).
4. **Writeback** the final state in **one SQLite transaction** per claim (better-sqlite3 is
   synchronous single-writer → no interleaving). Adjudications are append-only.
5. Re-running the same claim against the same starting snapshot → identical results. No
   wall-clock, no RNG, no float; rounding is `Math.round` (half-up).

## Accumulator storage (the memory)

One accumulator table keyed by `member_id` + `plan_year`, one row per tracked dimension:

| dimension | tracks | column used |
|---|---|---|
| `DEDUCTIBLE` | deductible met (cents) | `used_cents` |
| `OOP` | out-of-pocket met (cents) | `used_cents` |
| `LIMIT:<service_code>` | per-service usage | `used_cents` (dollar limit) **or** `used_count` (visit limit) |

The rule's `limit.unit` picks the column: `dollars` → `used_cents += plan pay`; `visits` →
`used_count += 1`. Limit rows are created lazily on first use. The decision write + every
accumulator increment happen in **one transaction** per line item. A dispute re-adjudication
reverses the original line's deltas, then applies the new ones, and appends a new Adjudication
row — the original is never mutated.

## PHI handling (minimal, demonstrated)

`Member.name`/`dob`, `Claim.provider`/`diagnosis_code` are sensitive. The engine input is
typed so it **structurally cannot** read them — adjudication keys on `member_id` → policy +
accumulators only. "Encryption at rest" is documented as a candidate (column-level) and
demonstrated in stance, not over-built for a 24–48h take-home.

## TDD build order — one behavior per red→green cycle

Tests 1–25 are pure (no DB). 26–27 touch SQLite.

```
GATES (pure denials)
 1. full_coverage line → member 0, plan = billed                 (simplest happy path)
 2. no rule → NO_COVERAGE, payable 0, DENIED
 3. excluded rule → EXCLUDED, payable 0
 4. covered == false → NO_COVERAGE, payable 0
 5. service date outside policy window → POLICY_NOT_ACTIVE
 6. requires_prior_auth && prior_auth_present == false → PRIOR_AUTH_REQUIRED, clean DENY
 7. duplicate fingerprint → DUPLICATE_LINE_ITEM, payable 0, original untouched

COST-SHARE math (single line, fresh accumulators)
 8. copay, allowed > copay → member = copay, plan = allowed − copay, deductible untouched
 9. copay, allowed < copay → member = allowed, plan = 0 (min clamp)
10. coinsurance, deductible already met → member = round(rate*allowed), plan = rest
11. coinsurance, allowed < remaining deductible → all to deductible, coins 0, plan 0
12. coinsurance DEDUCTIBLE CROSSING → split ded + coins; shares sum to allowed
13. coinsurance ODD CENTS (20% of 3333) → deterministic rounding; member + plan == allowed

LIMITS
14. visits, used < count → approved, limit_inc = 1
15. visits, used >= count → LIMIT_EXCEEDED, payable 0 (whole-visit, no straddle)
16. dollars, payable within remaining → approved, limit_inc = plan pay
17. dollars STRADDLE → plan caps at remaining, shortfall→member, LIMIT_EXCEEDED, line APPROVED

OOP CAP
18. member share would pass oop_max → excess refunded to plan, OOP_MAX_REACHED
19. accumulator already at oop_max → next line plan pays 100%, member 0

CROSS-LINE / DETERMINISM
20. two coinsurance lines, one claim → line 2 sees line 1's advanced deductible
21. re-run identical claim on identical snapshot → identical results

AGGREGATION (line[] → claim)
22. all approved → claim APPROVED
23. all denied → claim DENIED
24. mix approved + denied → claim PARTIALLY_APPROVED
25. straddled-partial + full approved → claim PARTIALLY_APPROVED

WRITEBACK / INTEGRATION (SQLite)
26. full claim through the real store: accumulators persist, adjudications append-only, one txn
27. dispute reopens a line, re-adjudicates, preserves the original immutably          (last)
```

## Worked example

**Policy:** deductible $500 (50000c), OOP max $3000 (300000c).
**Starting accumulators:** `DEDUCTIBLE used_cents = 20000`, `OOP used_cents = 20000`, no limit rows.

**Claim** (in-policy date), 3 lines:

| Line | Service | Rule | Billed |
|---|---|---|---|
| L1 | unknown code | none | 8000c |
| L2 | PCP_VISIT | $25 copay (2500c), no deductible | 18000c |
| L3 | MRI | 20% coinsurance, applies_deductible, prior_auth_present=true | 120000c |

- **L1** → no rule → `NO_COVERAGE`, payable **0**, member 0, `DENIED`. Deltas all 0.
- **L2** (copay) → member = min(2500, 18000) = **2500c**; plan = **15500c**. Deductible waived;
  copay → OOP. Delta: `oop += 2500` → OOP met = 22500c. `[APPROVED, COPAY_APPLIED]`.
- **L3** (coinsurance) → remainingDeductible = 50000 − 20000 = 30000c; dedPortion = 30000c;
  remainder = 90000c; coinsPortion = round(0.20 × 90000) = 18000c; member = **48000c**;
  plan = **72000c**. OOP check: 22500 + 48000 = 70500c < 300000 → no clamp. Deltas:
  `deductible += 30000` (now 50000c, met), `oop += 48000` (now 70500c).
  `[APPROVED, DEDUCTIBLE_APPLIED, COINSURANCE_APPLIED]`.

| Line | status | payable | member owes |
|---|---|---|---|
| L1 | DENIED | $0 | $0 |
| L2 | APPROVED | $155 | $25 |
| L3 | APPROVED | $720 | $480 |

**Claim → `PARTIALLY_APPROVED`** (mix). Plan pays **$875**, member owes **$505**. Each covered
line satisfies `payable + member == billed`. Accumulators after: `DEDUCTIBLE 50000c`, `OOP 70500c`.
Re-running on the same starting snapshot reproduces these exact numbers.

## Deferred from v1 (do not build)

- copay-**then**-coinsurance stacking (ER) — approximated by the dominant component.
- visit-limit straddle (visits are whole-unit, hard stop only).
- out-of-network second cost-share column; fee schedule (allowed ≠ billed).
- multi-service-date claims; family / Rx accumulators; PPO reduce-to-50% penalty.
- reviewer queue — disputes auto re-adjudicate (Q4 leaning); no human review state in v1.
