# 01 — Framing: the coverage/policy mental model

Captured during the framing grilling session (2026-06-18). This is the *why* behind the
locked coverage model; the *what* lives in `PRD.md` and `docs/domain-model.md`.

## North star

The adjudication **engine** is the spine we go deep on — coverage rules + accumulators +
the per-line decision + explanations. The brief calls adjudication "the interesting
problem," and the heaviest rubric signals (rule representation, edge-case thinking,
explanation) all live there. Lifecycle + dispute are modeled cleanly but minimally.

The insurer side — **policy and coverage rules** — is modeled first, because that is the
data the whole engine reads. Members/claims are just what flows *through* it.

## What the brief actually mandates (vs. what we inferred)

Read literally, the problem statement names only four rule concepts: **covered**,
**excluded** (implied), **annual dollar limit** ("$Y per year"), and **deductible**.
Everything else — copay, coinsurance, OOP max, prior-auth, plan-year — is *domain-correct
inference*, legitimate under "research the domain, make assumptions," but owned by us. The
bar for each inferred field: *realistic AND earns its complexity*, not *required*.

## Two decisions that reshaped the model

1. **Cost-share is a discriminated union, not a stack of nullable fields.**
   `full_coverage | copay | coinsurance`. Real benefits use exactly one mechanism per
   service. The adjudicator becomes an exhaustive switch; incoherent rules are rejected at
   the type level. (Decision #5)

2. **Limits are unit-typed, not dollars-only.** `none | dollars | visits`. The brief's
   example is a dollar limit, but the *most common* real limit is a visit/day cap — which a
   cents-only field cannot express. One discriminator, one code path. (Decision #6)

## Deliberately deferred / dropped

- copay-**then**-coinsurance (ER) → approximated by dominant component.
- Prior-auth "reduce-to-50%" PPO penalty → clean denial instead.
- Network tier, metal tier, family deductible, separate Rx deductible, referral gating →
  omitted; they change no math in a single-network, per-member, allowed==billed v1.

## Payment direction & the PAID state

The brief says claims are submitted **for reimbursement** → the money flows **plan → member**
(not plan → provider; that's the direct-pay/assignment model, which is not ours). The member
already paid the provider off-system; the insurer reimburses the **payable** amount and the
member bears their **responsibility** (deductible + copay + coinsurance + over-limit).

- **PAID is reached by an explicit "settle" action** (not auto-derived): it moves an approved /
  partially-approved claim's payable lines to PAID and records the reimbursement total + time.
- **No real payment gateway** (out of scope) → assume disbursement success and record the
  transition. The brief mandates `paid` in the lifecycle, so we *do* track it.
- *Interface implication (deferred):* likely a 5th action (`settle`/`pay`).

## Member — the data subject and the anchor (confirmed)

**Role:** the insured person; bound **1—1 to a Policy** per plan year; the key that ties Policy
+ Accumulators to a person (accumulators keyed by `member_id` + `plan_year`); submits claims;
disputes decisions; receives reimbursement on PAID.

**Actions:** `submit claim` · `dispute line-item decision` · *(passive)* `receive reimbursement`.

**PHI / persona stance (concept; schema deferred):**
- Referenced everywhere by an **opaque `member_id` (patient id)**. The adjudication engine runs on
  `member_id → policy + accumulators` and **never needs the name** — that separation is how the
  design reflects "sensitive health data."
- **PII (name, personal details) is minimized, separated from adjudication data, and a candidate
  for encryption at rest.** Diagnosis codes + provider details sit on the claim/line-item.
- **One human persona — the Member** (submitter + disputer). No auth/roles (out of scope); the
  only other actor is the System/Adjudicator.
- Encryption mechanics + exact fields → resolved at schema modeling, not now.

## Still open

- Q4 dispute resolution (auto re-adjudicate vs. reviewer queue) — leaning auto.
- Q5 duplicate handling (hard reject vs. soft flag) — leaning soft flag.
- Member PII encryption mechanics + exact field list — at schema step.
