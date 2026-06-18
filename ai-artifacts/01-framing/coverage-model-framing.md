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

## Still open

- Q4 dispute resolution (auto re-adjudicate vs. reviewer queue) — leaning auto.
- Q5 duplicate handling (hard reject vs. soft flag) — leaning soft flag.
