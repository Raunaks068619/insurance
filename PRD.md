# PRD — Claims Processing System

Status: **locked**. Scope below is frozen for the duration of the build. Changes require
an explicit decision logged in `TRACK.md` with a reason. This document defines *what* and
*why*; `docs/` documents *how*.

## Problem

A health insurance member incurs medical expenses and submits a claim made of one or more
line items (each a service or procedure). The system must decide, per line item, whether
it is covered and how much to pay, move the claim and its line items through their
lifecycles, explain every decision in language a member can read, and let the member
dispute a line-item decision.

## Done-state (the metric)

For any submitted claim, the system produces — deterministically and within ~100ms on a
laptop — a per-line-item adjudication consisting of `(status, payable_amount_cents,
reason_code, explanation_text)`, where `payable_amount` is computed in integer cents by
applying the member's active coverage rules in a fixed order (eligibility → coverage →
prior-auth → annual limit → deductible → copay → coinsurance → out-of-pocket maximum);
the claim's overall status is derived by aggregating its line items; every decision is
explained by a stable reason code plus a sentence citing the rule and the numbers used;
the same claim submitted against the same accumulator state always yields the same result;
and a member can dispute any line item, which reopens it for re-adjudication while
preserving the original decision as an immutable record. Persisted accumulators (deductible
met, out-of-pocket met, per-service limit used) carry forward across claims within a plan
year so limits exhaust correctly.

## In scope (7)

1. Submit a claim with one or more line items (`POST /claims`).
2. Adjudicate each line item against the member's active coverage rules, in a fixed order.
3. Compute `payable_amount_cents` per line item (deductible, copay, coinsurance, limits, OOP max).
4. Track claim and line-item lifecycle states with validated transitions.
5. Aggregate line-item outcomes into a claim-level status (incl. partial approval).
6. Produce a per-decision explanation (reason code + human-readable text) and expose it (`GET /claims/:id/explanation`).
7. Dispute a line-item decision, reopening it for re-adjudication while preserving the original (`POST /claims/:id/line-items/:lid/dispute`).

## Out of scope (verbatim from the assignment)

- User registration, login, or authentication
- Policy purchase or enrollment flows
- Member or provider account management
- Email notifications or alerts
- Reporting dashboards or analytics
- Admin panels for managing policies, members, or providers
- Multi-tenant or multi-role access control

These are adjacent real-world concerns but they are not what we are evaluating. Building
them will not improve the score.

## Interface (4 REST endpoints)

| Method & path | Purpose |
|---|---|
| `POST /claims` | Submit a claim with line items; runs adjudication; returns claim + per-line results. |
| `GET /claims/:id` | Fetch a claim with its line items, statuses, and payable amounts. |
| `GET /claims/:id/explanation` | Return the full explanation: per line item, the reason code, the rule applied, and the numbers used. |
| `POST /claims/:id/line-items/:lid/dispute` | Open a dispute on one line item; reopen for re-adjudication; preserve the prior decision. |

The API exists to demonstrate the domain, not as a product surface. No auth, no CRUD
beyond these four routes. Seed data (members, policies, coverage rules, accumulators) is
loaded by a seed script, not via the API.

## Domain primer (terminology)

| Term | Definition |
|---|---|
| **Member** | The insured person who submits claims under a policy. |
| **Policy** | The contract binding a member to a set of coverage rules for a plan year, with an effective and termination date. |
| **Coverage rule** | Data describing how one service type is covered: whether covered, annual limit, deductible applicability, copay, coinsurance rate, prior-auth requirement, exclusions. |
| **Deductible** | Amount the member pays out of pocket each plan year before the plan starts paying. Tracked by an accumulator. |
| **Copay** | A fixed dollar amount the member pays per service (e.g. $30 per visit). |
| **Coinsurance** | A percentage of the allowed amount the member pays after the deductible (e.g. plan pays 80%, member pays 20%). |
| **OOP max (out-of-pocket maximum)** | The annual ceiling on what a member pays; once reached, the plan pays 100% of covered services for the rest of the year. |
| **Accumulator** | Persisted running totals per member per plan year: deductible met, OOP met, and per-service-limit used. The memory that makes limits exhaust correctly across claims. |
| **EOB (Explanation of Benefits)** | The member-facing statement explaining what was covered, paid, and owed, and why. Our `/explanation` endpoint is an EOB in miniature. |
| **CARC** | Claim Adjustment Reason Code — the industry's standardized code for *why* an amount was adjusted/denied. Our `ReasonCode` enum is a simplified, internal analog. |
| **RARC** | Remittance Advice Remark Code — supplementary remark accompanying a CARC. Out of scope to model fully; noted for vocabulary fidelity. |

## Success criteria mapped to the rubric

| Rubric signal | How this build satisfies it |
|---|---|
| Domain decomposition | Explicit entities (Member, Policy, CoverageRule, Claim, LineItem, Adjudication, Accumulator, Dispute) with clear relationships in `docs/domain-model.md`. |
| Rule representation | Coverage rules are typed config data applied by a fixed-order adjudicator — not hardcoded branches, not a DSL. |
| State management | Two explicit state machines (claim, line item) with validated transitions and derived claim status. |
| Edge-case thinking | Partial approval, limit straddling, duplicate line items, dispute reopen, out-of-period policy, integer-cents money — each covered by a named test. |
| Explanation capability | Every decision carries a stable reason code and a sentence citing the rule and numbers; exposed via `/explanation`. |
| Test-first git history | Red→green commit pairs; tests encode domain rules, not HTTP status codes. |
| Honest self-review | `docs/self-review.md` is a calibrated gap-list. |

## Documented assumptions

1. **Single currency, USD, integer cents.** No multi-currency, no rounding policy beyond banker's-free integer math (round half-up at the final cents only where a percentage is applied).
2. **One policy per member per plan year.** No coordination-of-benefits across multiple policies.
3. **In-network only for v1.** Out-of-network is modeled as either not-covered or a separate rule set if time permits; default assumption documented in `TRACK.md`.
4. **Allowed amount == billed amount.** No fee schedule / provider-negotiated rate lookup; the billed amount is treated as the allowed amount. A real system would apply a fee schedule first.
5. **Plan year is a fixed calendar window on the policy.** Accumulator periods align to the policy's plan-year boundaries, not a rolling window.
6. **Prior authorization is a boolean precondition** recorded on the claim/line item, not a separate workflow. If required and absent, the line is denied with `PRIOR_AUTH_REQUIRED`.
7. **Disputes are member-initiated and immediately re-adjudicated** under current rules/accumulators; no human-reviewer queue. The original decision is preserved immutably.
8. **Determinism over wall-clock.** Adjudication reads a snapshot of accumulators; concurrency control beyond SQLite's single-writer model is out of scope and noted.
