---
name: insurance-domain
description: Load whenever modeling, researching, or naming anything in the claims domain — entities, coverage rules, reason codes, adjudication order, state machines, edge cases.
---

# Insurance domain skill

Load this before you model, name, or research anything in the domain. It is the shared
vocabulary and the canonical adjudication logic. If the code and this file disagree, one
of them is a bug — reconcile and log the decision in `TRACK.md`.

## Core entities

| Entity | Responsibility | Key fields |
|---|---|---|
| **Member** | The insured person (data subject). | `id`, `name` + `dob` (sensitive PHI, encrypted), `policy_id` |
| **Policy** | Binds a member to coverage for a plan year. | `id`, `member_id`, `plan_year`, `effective_date`, `termination_date`, `deductible_cents`, `oop_max_cents` |
| **CoverageRule** | How one service type is covered. | `policy_id`, `service_code`, `covered`, `excluded`, `cost_share` (discriminated: `full_coverage` \| `copay{copay_cents}` \| `coinsurance{rate}`), `applies_deductible`, `limit` (discriminated: `none` \| `dollars{amount_cents}` \| `visits{count}`), `requires_prior_auth` |
| **Claim** | A submission grouping line items. | `id`, `member_id`, `service_date` (claim-level), `provider` + `diagnosis_code` (sensitive PHI, encrypted, **not** adjudicated), `status` (derived) |
| **LineItem** | One service on a claim; the unit of adjudication. | `id`, `claim_id`, `service_code`, `billed_cents`, `units`, `prior_auth_present`, `status`, `fingerprint` |
| **Adjudication** | The immutable decision for a line item. | `line_item_id`, `status`, `payable_cents`, `member_responsibility_cents`, `reasons` (ReasonCode[]), `explanation`, `created_at` |
| **Accumulator** | Persisted running totals per member per plan year. | `member_id`, `plan_year`, `deductible_met_cents`, `oop_met_cents`, `limit_used` per `service_code` (interpreted in the rule's limit unit — cents for `dollars`, a visit count for `visits`) |
| **Dispute** | A member challenge to a line-item decision. | `id`, `line_item_id`, `original_adjudication_id`, `reason`, `opened_at`, `resolved_at`, `outcome` |

Relationships: Member 1—1 Policy (per plan year); Policy 1—N CoverageRule; Member 1—N
Claim; Claim 1—N LineItem; LineItem 1—N Adjudication (history; latest is current);
LineItem 1—N Dispute; Member 1—N Accumulator (one per plan year, with per-service limit rows).

**Closed service-code catalog (12):** `PREVENTIVE`, `PCP_VISIT`, `SPECIALIST_VISIT`,
`URGENT_CARE`, `EMERGENCY_ROOM`, `LAB`, `MRI`, `OUTPATIENT_SURGERY`, `INPATIENT_HOSPITAL`,
`PHYSICAL_THERAPY`, `CHIROPRACTIC`, `ADULT_DENTAL`. An unlisted `service_code` is accepted at
intake and denied `NO_COVERAGE` at adjudication (never an intake reject).

## Terminology (precise)

- **Billed amount** — what the provider charged for the line item.
- **Allowed amount** — what the plan recognizes as payable basis. v1 assumption: allowed == billed (no fee schedule).
- **Cost-share** — how the member shares the cost of a *covered* service. Exactly **one of three mechanisms** per rule, modeled as a discriminated union (not three nullable fields): **full coverage**, **copay**, or **coinsurance**.
- **Deductible** — annual member-paid amount before the plan starts paying coinsurance. Drawn down by `deductible_met_cents`. Copay services normally **waive** the deductible; coinsurance services apply it first.
- **Copay** — fixed per-service member charge (e.g. $25/visit). Deductible normally waived; the copay still counts toward OOP.
- **Coinsurance** — member's percentage share of the post-deductible allowed amount; `rate` is the member's share (0.20 = member pays 20%).
- **Full coverage** — plan pays 100%, no deductible, no member share (e.g. ACA-mandated preventive care).
- **Annual limit** — cap on a service per plan year, expressed in an explicit **unit**: `dollars` (max the plan pays) or `visits` (max approved visits/days); `none` = uncapped. Tracked by `limit_used` in the same unit.
- **OOP max** — annual ceiling on member spend; once `oop_met_cents` reaches it, plan pays 100%.
- **Member responsibility** — deductible portion + copay + coinsurance portion the member owes.
- **Payable** — what the plan pays = allowed − member responsibility, capped by any remaining dollar limit.

## ReasonCode enum

```ts
export enum ReasonCode {
  APPROVED = "APPROVED",                       // covered and (at least partly) payable
  NO_COVERAGE = "NO_COVERAGE",                 // no rule for this service / not covered
  EXCLUDED = "EXCLUDED",                       // explicitly excluded by the rule
  LIMIT_EXCEEDED = "LIMIT_EXCEEDED",           // annual limit already exhausted
  DEDUCTIBLE_APPLIED = "DEDUCTIBLE_APPLIED",   // part/all went to the deductible
  COPAY_APPLIED = "COPAY_APPLIED",             // a copay reduced the payable
  COINSURANCE_APPLIED = "COINSURANCE_APPLIED", // coinsurance split reduced the payable
  OOP_MAX_REACHED = "OOP_MAX_REACHED",         // OOP max hit; plan paid 100%
  PRIOR_AUTH_REQUIRED = "PRIOR_AUTH_REQUIRED", // rule requires prior auth, none present
  DUPLICATE_LINE_ITEM = "DUPLICATE_LINE_ITEM", // same fingerprint already adjudicated
  POLICY_NOT_ACTIVE = "POLICY_NOT_ACTIVE",     // service date outside policy active window
  DISPUTED_OVERRIDE = "DISPUTED_OVERRIDE",     // decision changed via dispute resolution
}
```

A line item's final `reason_code` is the *dominant* reason for its outcome. The
explanation text may mention several effects (deductible + coinsurance), but one code
classifies the decision. Approved-with-cost-share lines are `APPROVED`; the explanation
carries the breakdown.

## Canonical adjudication order (mechanism-aware)

> ⚠️ **C3 adjudication behavior is being finalized — treat this section as PROVISIONAL.**
> In particular, prior-auth-missing may route to `NEEDS_REVIEW` (not a clean denial — see
> below), and `reasons` is an array. The artifact *shapes* are locked; the *flow* is not.

Apply per line item, in this exact order. Short-circuit denials return immediately. The
cost-share step is a **switch on `cost_share.type`**, not a fixed deductible→copay→coinsurance
sequence — a service is covered by exactly one mechanism.

1. **Policy active?** Service date within `[effective_date, termination_date]`. Else → `POLICY_NOT_ACTIVE`, payable 0.
2. **Rule exists?** A CoverageRule for `service_code` exists. Else → `NO_COVERAGE`, payable 0.
3. **Covered & not excluded?** `excluded == true` → `EXCLUDED`; `covered == false` → `NO_COVERAGE`. Payable 0.
4. **Prior auth satisfied?** If `requires_prior_auth` and not `prior_auth_present` → `PRIOR_AUTH_REQUIRED`. *(Provisional: the line likely goes to `NEEDS_REVIEW` rather than a clean `DENIED`/payable 0 — confirmed in the C3 brainstorm.)*
5. **Limit remaining?** Read `limit_used` for the service_code:
   - `unit: none` → skip.
   - `unit: visits` → if `used_count >= count` → `LIMIT_EXCEEDED`, payable 0 (whole-visit unit; no straddle).
   - `unit: dollars` → if `used_cents >= amount_cents` → `LIMIT_EXCEEDED`, payable 0 (partial straddle handled in step 7b).
6. **Compute base allowed.** `allowed = billed` (v1). This is the basis for cost-sharing.
7. **Apply cost-share** — switch on `cost_share.type`:
   - **full_coverage** → member 0; plan = allowed. (Deductible untouched.)
   - **copay** → member = min(`copay_cents`, allowed); copay accrues to OOP, **not** to the deductible. If `applies_deductible` is set (rare for copay), draw remaining deductible first. Plan = allowed − member.
   - **coinsurance** → if `applies_deductible`, draw remaining deductible from allowed (member, accrues to `deductible_met_cents`); then member += round(`rate` × remainder); plan = allowed − member.
   - **(7b) Dollar-limit straddle:** if `unit: dollars`, cap plan pay at `amount_cents − used_cents`; any shortfall moves to member responsibility and earns `LIMIT_EXCEEDED` on that portion.
8. **Apply OOP cap.** If member responsibility would push `oop_met_cents` past `oop_max_cents`, refund the excess to the plan's payable (`OOP_MAX_REACHED`); member never pays past the cap.
9. **Writeback.** Persist the Adjudication; increment `deductible_met_cents`, `oop_met_cents`, and `limit_used` (dollars: += plan pay; visits: += 1) atomically.

Determinism: steps 5–9 read accumulator values as a snapshot at the start of the claim's
adjudication and write back in line-item order, so re-running the same claim against the
same starting accumulators yields identical results.

## State machines

### Claim

```
            ┌──────────────┐
            │  SUBMITTED   │
            └──────┬───────┘
                   │ adjudicate
                   ▼
            ┌──────────────┐
            │ UNDER_REVIEW │  (transient: line items being adjudicated)
            └──────┬───────┘
        ┌──────────┼───────────┐
        ▼          ▼           ▼
   ┌─────────┐ ┌────────────────┐ ┌────────┐
   │ APPROVED│ │PARTIALLY_APPROVED│ │ DENIED │
   └────┬────┘ └───────┬────────┘ └───┬────┘
        └──────────────┼──────────────┘
                       │ all payable lines settled
                       ▼
                  ┌─────────┐
                  │  PAID   │
                  └─────────┘
   (any state with an open dispute → re-enters UNDER_REVIEW)
```

### Line item

```
   SUBMITTED → ADJUDICATING → { APPROVED | PARTIALLY_APPROVED | DENIED }
                                        │
                                  dispute opened
                                        ▼
                                   DISPUTED → re-adjudicate → { APPROVED | PARTIALLY_APPROVED | DENIED }
   APPROVED / PARTIALLY_APPROVED → PAID
```

**Locked state set (infographic 04):** `PENDING → { APPROVED | DENIED | NEEDS_REVIEW } → PAID`;
a dispute reopens `DENIED → NEEDS_REVIEW`. `PARTIALLY_APPROVED` is **claim-level only**. The
names in the diagram above (`SUBMITTED`/`ADJUDICATING`/line-level `PARTIALLY_APPROVED`) are
superseded by these; the routing into `NEEDS_REVIEW` is provisional C3 work.

### Aggregation logic (line items → claim)

- All line items `DENIED` → claim `DENIED`.
- All line items `APPROVED` (full payable, nothing denied) → claim `APPROVED`.
- Mix of approved/partial and denied, or any `PARTIALLY_APPROVED` line → claim `PARTIALLY_APPROVED`.
- Any line item `DISPUTED`/re-adjudicating → claim `UNDER_REVIEW`.
- Claim `PAID` only when every payable line item is `PAID` and none are open/disputed.

## Edge cases to test

| Edge case | Expected behavior |
|---|---|
| **Partial approval** | 5 lines, 3 covered / 1 denied / 1 needs auth → claim `PARTIALLY_APPROVED`; each line keeps its own status + reason. |
| **Dollar-limit straddling** | A line whose payable would exceed the remaining **dollar** limit → plan pays up to the remaining limit; the rest becomes member responsibility; `LIMIT_EXCEEDED` on the unpaid portion, `APPROVED` with a note on the paid portion. |
| **Visit-limit exhaustion** | A **visit**-limited service past its count (e.g. the 21st PT visit when capped at 20/yr) → `LIMIT_EXCEEDED`, payable 0; whole-visit unit, no straddle. |
| **Full coverage (preventive)** | A `full_coverage` rule (e.g. annual physical) → plan pays 100%, member 0, deductible untouched. |
| **Copay waives deductible** | A `copay` service → member pays only the copay even with an unmet deductible; the copay still accrues to OOP. |
| **Duplicate line item** | Same fingerprint (member + service_code + service_date + billed) already adjudicated → `DUPLICATE_LINE_ITEM`, payable 0, original untouched. |
| **Dispute reopens** | Disputing a line item creates a Dispute, sets line `DISPUTED`, re-adjudicates, and preserves the original Adjudication immutably. |
| **Out-of-period** | Service date outside the policy active window → `POLICY_NOT_ACTIVE`. |
| **Integer cents** | Coinsurance on odd amounts (e.g. 20% of 3333 cents) rounds deterministically; member + plan shares always sum to allowed. |
| **Deductible crossing** | A line that partly meets the remaining deductible → split between deductible (member) and coinsurance; accumulator advances exactly. |
| **OOP max reached mid-claim** | Once `oop_met` hits `oop_max`, subsequent lines pay 100% with `OOP_MAX_REACHED`. |

## Anti-patterns (do not do)

- A rules **DSL** or pluggable engine. Coverage rules are typed config records.
- **Three nullable cost-share fields** (`copay_cents` + `coinsurance_rate` both present on every rule and applied in sequence). Model cost-share as a **discriminated union** — one mechanism per rule (`full_coverage` \| `copay` \| `coinsurance`).
- **A dollars-only limit field.** Model the annual limit with an explicit **unit** (`dollars` \| `visits` \| `none`); visit/day caps are the most common real limit and a cents field cannot express them.
- **Float money.** Integer cents only; percentages applied with explicit rounding at the cents step.
- **Hardcoded rules** inside adjudication branches. Adjudicator reads CoverageRule data; logic is generic.
- A single `status` string with **magic transitions**. Model both lifecycles as explicit state machines with validated transitions; reject illegal transitions.
- Mutating an Adjudication on dispute. Adjudications are **append-only**; disputes create new ones and preserve the old.
