# Domain model

> Status: template, ~60% pre-filled from framing. Replace `TBD` / `_fill in as you go_`
> as the code firms up. This doc must match the code; if they drift, the code wins and
> this gets updated.

## Why this decomposition

Claims processing is, at its core, a function: `(claim, member's coverage, prior usage) →
per-line-item decision`. The model separates the *rules* (static coverage config), the
*facts* (claim + line items), the *memory* (accumulators), and the *decisions*
(adjudications, append-only). That separation is what makes adjudication deterministic and
explainable: every decision is reproducible from rules + facts + a snapshot of memory.

## Entities and relationships

| Entity | Responsibility |
|---|---|
| Member | The insured person who submits claims. |
| Policy | Binds a member to coverage rules for one plan year, with active dates, deductible, OOP max. |
| CoverageRule | How one service type is covered: covered/excluded, one cost-share mechanism (`full_coverage` \| `copay` \| `coinsurance`), deductible applicability, a unit-typed limit (`none` \| `dollars` \| `visits`), prior-auth. |
| Claim | A submission grouping line items; has a lifecycle status and a fingerprint. |
| LineItem | One service on a claim; has its own lifecycle status. |
| Adjudication | The immutable decision for a line item (status, payable, member responsibility, reason code, explanation). Append-only. |
| Accumulator | Persisted per-member-per-plan-year totals: deductible met, OOP met, per-service limit used (in the rule's unit — cents for `dollars`, a count for `visits`). |
| Dispute | A member challenge that reopens a line item and preserves the prior decision. |
| StatusTransition | Append-only audit row for every claim/line status change: `from`, `to`, `actor`, `reason`, `seq`. The member-facing lifecycle timeline. |

```
Member 1───1 Policy 1───N CoverageRule
   │
   ├───N Claim 1───N LineItem 1───N Adjudication   (latest = current; history retained)
   │                      │
   │                      └───N Dispute
   └───N Accumulator (1 per plan year, + per-service limit rows)
```

### Claim & LineItem field detail (locked; adjudication behavior is separate)

```ts
type Claim = {
  id: string;
  memberId: string;             // resolves to Member → Policy
  serviceDate: string;          // CLAIM-level ISO date
  provider?: string;            // captured PHI — encrypted at rest, NOT adjudicated
  diagnosisCode?: string;       // captured PHI — encrypted at rest, NOT adjudicated
  status: ClaimStatus;          // DERIVED from line items
  lineItems: LineItem[];        // >= 1
};

type LineItem = {
  id: string;
  claimId: string;
  serviceCode: string;          // closed 12-entry catalog; unlisted → NO_COVERAGE
  billedCents: number;          // positive integer (allowed == billed in v1)
  units: number;                // default 1
  priorAuthPresent: boolean;    // default true (absence = auth present); explicit false → PRIOR_AUTH_REQUIRED
  status: LineItemStatus;       // PENDING → APPROVED | DENIED | NEEDS_REVIEW (no PAID in v1)
  fingerprint: string;          // memberId + serviceCode + serviceDate + billedCents
};
```

**Service-code catalog (closed, 12):** `PREVENTIVE`, `PCP_VISIT`, `SPECIALIST_VISIT`,
`URGENT_CARE`, `EMERGENCY_ROOM`, `LAB`, `MRI`, `OUTPATIENT_SURGERY`, `INPATIENT_HOSPITAL`,
`PHYSICAL_THERAPY`, `CHIROPRACTIC`, `ADULT_DENTAL`. Each maps to one CoverageRule on the
policy; an unlisted code is accepted at intake and denied `NO_COVERAGE` at adjudication.

**PHI:** `Member.name`/`dob`, `Claim.provider`/`diagnosisCode` are sensitive — minimized,
separated from adjudication data, encryption-at-rest candidates. The engine never reads them.

### Intake (C2, N1–N5)

Receive → structural validation (fields, ≥1 line, positive-integer `billedCents`, real
non-future `serviceDate`) → member resolution (exists, else reject) → compute fingerprint →
persist (`Claim = SUBMITTED`, lines `PENDING`). A structural/identity failure is an HTTP
`4xx` reject with `{ errors: [{ field, code, message }] }` and **nothing persisted** — there
is no `REJECTED` state. Member *existence* rejects at intake; policy *active-on-date* denies
at adjudication.

## Coverage rule shape

Rules are typed config data, not code and not a DSL. Shape grounded in research across
UnitedHealthcare, Aetna, Cigna, BCBS, and ACA structure (`ai-artifacts/02-domain-research/`):

```ts
type CoverageRule = {
  policyId: string;
  serviceCode: string;        // closed catalog: "PREVENTIVE", "PCP_VISIT", "MRI", "PHYSICAL_THERAPY"…
  covered: boolean;
  excluded: boolean;          // explicit exclusion beats "covered"
  costShare:                  // discriminated union — exactly one mechanism per service
    | { type: "full_coverage" }
    | { type: "copay"; copayCents: number }
    | { type: "coinsurance"; rate: number };   // member share, 0.0–1.0 (0.2 = member pays 20%)
  appliesDeductible: boolean; // copay → usually false; coinsurance → usually true
  limit:                      // discriminated union — the unit matters
    | { unit: "none" }
    | { unit: "dollars"; amountCents: number } // "$Y per year" (the brief's example)
    | { unit: "visits"; count: number };       // "20 PT visits/year" (the #1 real limit)
  requiresPriorAuth: boolean;
};
```

Money is integer cents everywhere; `coinsurance.rate` is the *member's* share. Cost-share is a
discriminated union (not nullable copay + coinsurance fields) because real benefits use exactly
one mechanism — preventive is `full_coverage`, office/ER/urgent are `copay`, imaging/surgery/
hospital are `coinsurance` after deductible. The limit's `unit` is the load-bearing addition: a
dollars-only field cannot express visit/day caps, which are the most common real limit.

## Adjudication order (mechanism-aware)

Per line item, short-circuiting on denial. The cost-share step is a **switch on
`costShare.type`**, not a fixed deductible→copay→coinsurance sequence.

1. Policy active for the service date? else `POLICY_NOT_ACTIVE`.
2. Rule exists for the service code? else `NO_COVERAGE`.
3. Covered and not excluded? else `EXCLUDED` / `NO_COVERAGE`.
4. Prior auth satisfied if required? else `PRIOR_AUTH_REQUIRED` — a clean `DENIED`, not `NEEDS_REVIEW` (decision #8).
5. Limit remaining? `none` → skip; `visits` → if count used up, `LIMIT_EXCEEDED` (whole-visit, no straddle); `dollars` → if exhausted, `LIMIT_EXCEEDED` (partial straddle in 7b).
6. Compute allowed (v1: allowed = billed).
7. Apply cost-share — switch on `costShare.type`:
   - `full_coverage` → member 0, plan = allowed.
   - `copay` → member = min(copay, allowed); copay accrues to OOP, not the deductible.
   - `coinsurance` → if `appliesDeductible`, draw remaining deductible (member, accrues); then member += round(rate × remainder); plan = allowed − member.
   - (7b) dollar-limit straddle → cap plan pay at remaining limit; shortfall → member, `LIMIT_EXCEEDED`.
8. Apply OOP cap (once OOP max reached, plan pays 100%, `OOP_MAX_REACHED`).
9. Writeback: persist adjudication; increment deductible/OOP atomically and `limit_used` in the rule's unit (dollars: += plan pay; visits: += 1).

Full pipeline (gates vs math), the `adjudicate()` contract, cost-share math, determinism,
accumulator writeback, a worked numeric example, and the TDD build order live in
[`adjudication-plan.md`](adjudication-plan.md). Add more worked examples here as the
adjudicator is implemented.

## State machines

> **v1 scope:** no `PAID` state. The claim lifecycle ends at `APPROVED` / `PARTIALLY_APPROVED`
> / `DENIED`; settle/payment is deferred (decision #14). A dispute reopens a terminal claim to
> `UNDER_REVIEW`.

### Claim lifecycle

```
SUBMITTED → UNDER_REVIEW → { APPROVED | PARTIALLY_APPROVED | DENIED }   ← terminal in v1
                ▲                          │
                └──── dispute opened ──────┘   reopens a terminal claim → UNDER_REVIEW
```

### Line-item lifecycle

```
PENDING → ADJUDICATING → { APPROVED | DENIED }
                              │
                  dispute opened (ANY terminal line)
                              ▼
                         NEEDS_REVIEW → re-adjudicate → { APPROVED | DENIED }
```

**Locked state set:** line item `PENDING → { APPROVED | DENIED | NEEDS_REVIEW }`; a dispute
reopens **any terminal line** (`APPROVED` or `DENIED`) → `NEEDS_REVIEW`, which auto re-adjudicates
back to `APPROVED | DENIED` (decision #16 — members dispute underpayments, not only denials).
`PARTIALLY_APPROVED` is **claim-level only**, never a line state. **No `PAID` state in v1.**

Prior-auth-missing is a clean `DENIED`, **not** `NEEDS_REVIEW` (decision #8); `NEEDS_REVIEW` is
reached only via a dispute reopen and clears by auto re-adjudication. Transition *guards*
(illegal-transition rejection) are finalized with the C4 lifecycle work; illegal transitions
must be rejected, not silently ignored.

### Aggregation (line items → claim status)

| Line-item outcomes | Claim status |
|---|---|
| All denied | DENIED |
| All fully approved | APPROVED |
| Any partial, or mix of approved + denied | PARTIALLY_APPROVED |
| Any disputed / re-adjudicating | UNDER_REVIEW |

### Status-transition log (audit trail) — decision #15

Every status change for a claim or line item is appended to one shared, append-only table —
the member-facing lifecycle history.

| column | meaning |
|---|---|
| `entity_type` | `CLAIM` \| `LINE_ITEM` |
| `entity_id` | claim_id or line_item_id |
| `from_status` / `to_status` | the move (`from` null on create) |
| `actor` | `SYSTEM` \| `MEMBER` |
| `reason` | coarse cause tag (`SUBMIT` \| `ADJUDICATED` \| `AGGREGATED` \| `DISPUTE_REOPEN`) — **not** a `ReasonCode` |
| `seq` | injected logical clock — deterministic ordering |
| `created_at` | wall-clock; **metadata only**, never read by logic/tests |

One `setStatus()` helper writes the status column *and* appends the transition in the same
transaction, so the log can never drift. Written at 4 sites: submit · each line adjudicated ·
claim roll-up · dispute reopen. Surfaced as a `timeline` field on `GET /claims/:id` (no new
endpoint). Append-only; never replayed to derive current status — status columns stay the
source of truth (this is an audit log, not event sourcing).

## Dispute (first-class) — decision #16

A member challenge to one terminal line item's decision; **synchronous** re-adjudication, no
reviewer queue. The crux: a deterministic engine re-running identical inputs is a no-op, so a
dispute carries **corrected facts** and/or binds to **current** rules to flip an outcome.

```ts
type Dispute = {
  id: string;
  lineItemId: string;
  originalAdjudicationId: string;     // the immutable decision being challenged
  resolvedAdjudicationId: string;     // the new decision this dispute produced
  reason: string;                     // member rationale, surfaced verbatim
  corrected?: {                       // the ONLY amendable line fields
    priorAuthPresent?: boolean; serviceCode?: string; billedCents?: number; units?: number };
  outcome: "UPHELD" | "OVERTURNED" | "PARTIALLY_OVERTURNED" | "MODIFIED";
  state: "OPEN" | "RESOLVED";
  openedAt: string; resolvedAt: string;
};
```

Overlay `corrected` on the line, re-run the adjudicator against **current** rules and
`current accumulator − this line's own original deltas` (single-line net-out; no cross-claim
cascade — documented limitation). `outcome` is a diff of the new vs original adjudication; line
moves `{APPROVED|DENIED} → NEEDS_REVIEW → {APPROVED|DENIED}`, claim `terminal → UNDER_REVIEW →
terminal`, dispute `OPEN → RESOLVED`. Disputable only from a **terminal** line (`PENDING`/
`UNDER_REVIEW` → `409`; missing/mismatched → `404`). Surfaced on `GET /claims/:id` as a per-line
`disputes[]` + `adjudication_history` + `timeline`. Mechanics + TDD cycles 32–36 in
[`adjudication-plan.md`](adjudication-plan.md).

## Reason codes

`APPROVED, NO_COVERAGE, EXCLUDED, LIMIT_EXCEEDED, DEDUCTIBLE_APPLIED, COPAY_APPLIED,
COINSURANCE_APPLIED, OOP_MAX_REACHED, PRIOR_AUTH_REQUIRED, DUPLICATE_LINE_ITEM,
POLICY_NOT_ACTIVE, DISPUTED_OVERRIDE`. One dominant code classifies each decision; the
explanation text carries the full breakdown. `DISPUTED_OVERRIDE` is reserved for a v2 reviewer
override and is **unused in v1** — an overturned dispute carries the re-derived reason codes of its
new decision (decision #16). Mapping table (code → template sentence):
_fill in alongside the explanation builder._

## Resolved modeling questions (this framing session)

- **Cost-share representation** → discriminated union (`full_coverage` \| `copay` \| `coinsurance`), one mechanism per service. Research showed real benefits use exactly one. (TRACK #5)
- **Limit representation** → unit-typed (`none` \| `dollars` \| `visits`). Visit/day caps are the most common real limit and a dollars-only field can't express them. (TRACK #6)
- **Q1 prior-auth** → boolean precondition; missing → `PRIOR_AUTH_REQUIRED`, payable 0. The PPO reduce-to-50% penalty is a documented divergence, not built.
- **Q2 out-of-network** → in-network only for v1 (allowed == billed); unlisted/OON service → `NO_COVERAGE`. Network/metal-tier/family fields omitted (change no math).
- **Q3 accumulator period** → fixed plan-year window keyed on the policy; resets at plan-year boundary. No rolling 12-month.

## Worked numeric examples

### Example 1 — Coinsurance with deductible draw (MRI, $1,000 billed)

Setup:
- Rule: 20% coinsurance, `appliesDeductible = true`, `requiresPriorAuth = true`, priorAuth present
- Policy: $500 deductible, $3,000 OOP max
- Prior accumulator: `deductible_met = 0`, `oop_met = 0`

Step-by-step:
```
allowed = billed = $1,000               (v1: allowed == billed)

Step 7 — coinsurance branch:
  remainingDeductible = max(0, 500 − 0)   = $500
  dedPortion  = min(500, 1000)             = $500   → member owes; deductible_met += $500
  remainder   = 1000 − 500                = $500
  coinsPortion = round(0.20 × 500)        = $100   → member owes
  member = 500 + 100                      = $600
  plan   = 1000 − 600                     = $400   (computed last; sum invariant: $600 + $400 = $1,000 ✓)

Step 8 — OOP cap:
  oop_met + member share = 0 + 600 = $600 < $3,000 → no cap triggered

Writeback deltas:
  deductibleIncCents = 500
  oopIncCents        = 600
  limitInc           = 0     (limit: none)
```

Result: `APPROVED`, plan pays $400, member owes $600
Reasons: `[APPROVED, DEDUCTIBLE_APPLIED, COINSURANCE_APPLIED]`

---

### Example 2 — Copay (PCP visit, $200 billed)

Setup:
- Rule: $25 copay, `appliesDeductible = false`
- Prior accumulator: `deductible_met = 0`, `oop_met = 0`

Step-by-step:
```
allowed = billed = $200

Step 7 — copay branch:
  member = min(25, 200) = $25     → copay; does NOT draw the deductible
  plan   = 200 − 25    = $175

Writeback deltas:
  deductibleIncCents = 0          (copay branch never touches the deductible)
  oopIncCents        = 25         (copay accrues to OOP)
  limitInc           = 0
```

Result: `APPROVED`, plan pays $175, member owes $25
Reasons: `[APPROVED, COPAY_APPLIED]`

---

### Example 3 — Visit-limit gate (Chiropractic, 13th visit when cap is 12)

Setup:
- Rule: `limit = { unit: "visits", count: 12 }`, `costShare = copay($15)`
- Prior accumulator: `limit_used = 12` (12 visits already this plan year)

Step-by-step:
```
Step 5 — visit limit gate:
  limit_used (12) < count (12) → false → SHORT-CIRCUIT: LIMIT_EXCEEDED

payable = 0, member = 0
No accumulator delta (gate denials never update accumulators)
```

Result: `DENIED`, plan pays $0, member owes $0
Reasons: `[LIMIT_EXCEEDED]`

---

### Example 4 — OOP maximum already met (specialist, $1,000 billed)

Setup:
- Rule: 20% coinsurance, `appliesDeductible = true`
- Policy: $500 deductible, $3,000 OOP max
- Prior accumulator: `deductible_met = 500`, `oop_met = 3000` (OOP max already exhausted)

Step-by-step:
```
allowed = billed = $1,000

Step 7 — coinsurance branch:
  remainingDeductible = max(0, 500 − 500) = $0
  dedPortion   = 0
  coinsPortion = round(0.20 × 1000) = $200 → member owes (tentative)

Step 8 — OOP cap:
  oop_met + member = 3000 + 200 = $3,200 > $3,000
  excess = 3200 − 3000 = $200 → refund excess to plan
  member = 200 − 200 = $0
  plan   = 1000 − 0 = $1,000
```

Result: `APPROVED`, plan pays $1,000, member owes $0
Reasons: `[APPROVED, COINSURANCE_APPLIED, OOP_MAX_REACHED]`

## Transition tables

### Claim state transitions

| From | To | Actor | Trigger |
|---|---|---|---|
| _(none)_ | `SUBMITTED` | `SYSTEM` | Claim persisted at intake |
| `SUBMITTED` | `APPROVED` | `SYSTEM` | All lines approved after adjudication |
| `SUBMITTED` | `PARTIALLY_APPROVED` | `SYSTEM` | Mixed approved + denied, or any dollar-limit straddle |
| `SUBMITTED` | `DENIED` | `SYSTEM` | All lines denied after adjudication |
| `APPROVED` | `UNDER_REVIEW` | `MEMBER` | Member opens a dispute on any line |
| `PARTIALLY_APPROVED` | `UNDER_REVIEW` | `MEMBER` | Member opens a dispute on any line |
| `DENIED` | `UNDER_REVIEW` | `MEMBER` | Member opens a dispute on any line |
| `UNDER_REVIEW` | `APPROVED` | `SYSTEM` | Dispute auto re-adjudication resolves all lines approved |
| `UNDER_REVIEW` | `PARTIALLY_APPROVED` | `SYSTEM` | Dispute re-adjudication produces a mix |
| `UNDER_REVIEW` | `DENIED` | `SYSTEM` | Dispute re-adjudication produces all-denied |

Note: `SUBMITTED → {APPROVED|PARTIALLY_APPROVED|DENIED}` is a single logical step in the
implementation (submit + adjudicate + aggregate run in one transaction). The transition log records
the full ordered sequence: claim `SUBMIT` → line `SUBMIT` (×N) → line `ADJUDICATED` (×N) →
claim `AGGREGATED`.

### Line-item state transitions

| From | To | Actor | Trigger |
|---|---|---|---|
| _(none)_ | `PENDING` | `SYSTEM` | Line persisted at intake (phase 1 of adjudication) |
| `PENDING` | `APPROVED` | `SYSTEM` | Line adjudicates to a covered payable |
| `PENDING` | `DENIED` | `SYSTEM` | Line adjudicates to any denial gate or zero payable |
| `APPROVED` | `NEEDS_REVIEW` | `MEMBER` | Member disputes this line (dispute reopen) |
| `DENIED` | `NEEDS_REVIEW` | `MEMBER` | Member disputes this line (dispute reopen) |
| `NEEDS_REVIEW` | `APPROVED` | `SYSTEM` | Auto re-adjudication overturns or partially changes the outcome |
| `NEEDS_REVIEW` | `DENIED` | `SYSTEM` | Auto re-adjudication upholds the denial |

Illegal transitions (e.g. `PENDING → NEEDS_REVIEW`, `APPROVED → DENIED` without a dispute) are
rejected by the `setStatus()` guard — the service never calls `setStatus()` with an invalid
transition, and the guard enforces this by mapping unknown `(from, to)` pairs to a thrown error at
runtime.
