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
| CoverageRule | How one service type is covered (covered?, limit, deductible applicability, copay, coinsurance, prior-auth, exclusion). |
| Claim | A submission grouping line items; has a lifecycle status and a fingerprint. |
| LineItem | One service on a claim; has its own lifecycle status. |
| Adjudication | The immutable decision for a line item (status, payable, member responsibility, reason code, explanation). Append-only. |
| Accumulator | Persisted per-member-per-plan-year totals: deductible met, OOP met, per-service limit used. |
| Dispute | A member challenge that reopens a line item and preserves the prior decision. |

```
Member 1───1 Policy 1───N CoverageRule
   │
   ├───N Claim 1───N LineItem 1───N Adjudication   (latest = current; history retained)
   │                      │
   │                      └───N Dispute
   └───N Accumulator (1 per plan year, + per-service limit rows)
```

ER detail and field-level types: _fill in as the schema lands in `app/src`._

## Coverage rule shape

Rules are typed config data, not code and not a DSL. Shape (subject to refinement):

```ts
type CoverageRule = {
  policyId: string;
  serviceCode: string;        // e.g. "OFFICE_VISIT", "MRI", "PHYSIO"
  covered: boolean;
  excluded: boolean;          // explicit exclusion beats "covered"
  annualLimitCents: number | null;   // null = no limit
  appliesDeductible: boolean;
  copayCents: number;         // 0 = none
  coinsuranceRate: number;    // member share, 0.0–1.0 (0.2 = member pays 20%)
  requiresPriorAuth: boolean;
};
```

Money is integer cents everywhere. `coinsuranceRate` is the *member's* share.

## Adjudication order (the 11 steps)

Per line item, short-circuiting on denial:

1. Policy active for the service date? else `POLICY_NOT_ACTIVE`.
2. Rule exists for the service code? else `NO_COVERAGE`.
3. Covered and not excluded? else `EXCLUDED` / `NO_COVERAGE`.
4. Prior auth satisfied if required? else `PRIOR_AUTH_REQUIRED`.
5. Annual limit remaining? else `LIMIT_EXCEEDED`.
6. Compute allowed (v1: allowed = billed).
7. Apply deductible (member pays, accrues to deductible accumulator).
8. Apply copay.
9. Apply coinsurance (member share); cap plan pay at remaining annual limit (straddling).
10. Apply OOP cap (once OOP max reached, plan pays 100%).
11. Writeback: persist adjudication; increment deductible/OOP/limit accumulators atomically.

Worked numeric examples: _add 2–3 once the adjudicator is implemented (deductible
crossing, coinsurance odd-cents, OOP cap)._

## State machines

### Claim lifecycle

```
SUBMITTED → UNDER_REVIEW → { APPROVED | PARTIALLY_APPROVED | DENIED } → PAID
                ▲                                                         │
                └──────────────── dispute opened ─────────────────────────┘
```

### Line-item lifecycle

```
SUBMITTED → ADJUDICATING → { APPROVED | PARTIALLY_APPROVED | DENIED }
                                   │
                             dispute opened
                                   ▼
                              DISPUTED → re-adjudicate → { APPROVED | PARTIALLY_APPROVED | DENIED } → PAID
```

Transition table (allowed/rejected transitions) with guards: _fill in as the machine is
implemented; illegal transitions must be rejected, not silently ignored._

### Aggregation (line items → claim status)

| Line-item outcomes | Claim status |
|---|---|
| All denied | DENIED |
| All fully approved | APPROVED |
| Any partial, or mix of approved + denied | PARTIALLY_APPROVED |
| Any disputed / re-adjudicating | UNDER_REVIEW |
| All payable lines paid, none open | PAID |

## Reason codes

`APPROVED, NO_COVERAGE, EXCLUDED, LIMIT_EXCEEDED, DEDUCTIBLE_APPLIED, COPAY_APPLIED,
COINSURANCE_APPLIED, OOP_MAX_REACHED, PRIOR_AUTH_REQUIRED, DUPLICATE_LINE_ITEM,
POLICY_NOT_ACTIVE, DISPUTED_OVERRIDE`. One dominant code classifies each decision; the
explanation text carries the full breakdown. Mapping table (code → template sentence):
_fill in alongside the explanation builder._

## Open modeling questions

- Q1 prior-auth: boolean precondition vs. pending/approved sub-state. Current: TBD (see TRACK.md).
- Q2 out-of-network: not-covered vs. parallel rule set. Current: TBD.
- Q3 accumulator period: fixed plan-year vs. rolling 12-month. Current: TBD.
