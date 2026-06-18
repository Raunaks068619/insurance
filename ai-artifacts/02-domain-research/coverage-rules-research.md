# 02 — Domain research: common coverage & policy rules

Synthesis of a 6-agent web-research pass (2026-06-18) across **UnitedHealthcare, Aetna,
Cigna, BCBS** Summary-of-Benefits-and-Coverage (SBC) documents plus **ACA/CMS/KFF**
structure. Purpose: ground our coverage-rule model in what real insurers actually do, not
in the scaffold's defaults. Raw multi-agent output retained in the session JSONL.

## Policy structure — keep vs. drop for v1

| Field | Plain English | v1? |
|---|---|---|
| plan_year + effective/termination | Active window; accumulators reset on it | **keep** — drives `POLICY_NOT_ACTIVE` + resets |
| annual deductible (individual) | Member pays this before coinsurance starts | **keep** — central to the coinsurance path |
| out-of-pocket max (individual) | Annual ceiling on member spend; then plan pays 100% | **keep** — drives `OOP_MAX_REACHED` |
| metal tier (Bronze→Platinum) | Actuarial band; explains *why* amounts differ | drop — amounts already on the rules; changes no math |
| network model (HMO/PPO/EPO) | Whether OON is covered, referrals needed | drop — single network in v1 |
| family deductible / OOP | Whole-family totals | drop — per-member accumulators in v1 |
| in vs out-of-network tiers | Second, higher cost-share column | drop — allowed==billed makes OON dead weight |
| separate Rx deductible | Drug-only deductible | drop — needs a 2nd accumulator; drugs not in scope |
| referral-required flag | HMO PCP gate | drop — no referral entity/check |

## Coverage rules — the common service categories

| Service | Cost-share | Deductible | Limit | Prior auth | How universal |
|---|---|---|---|---|---|
| Preventive / annual physical | **full coverage ($0)** | no | none | no | universal (ACA mandate) |
| Primary care visit | copay $20–$40 | no | none | no | universal |
| Specialist visit | copay $25–$80 | no | none | no | universal |
| Urgent care | copay $25–$75 | no | none | no | universal |
| Emergency room | copay $100–$750 (waived if admitted) | no | none | no | near-universal |
| Ambulance | coinsurance ~20% | yes | none | no | common |
| Lab / X-ray | coinsurance ~20% | yes | none | no | common |
| Advanced imaging (MRI/CT/PET) | coinsurance ~20% | yes | none | **yes** | universal |
| Outpatient surgery | coinsurance ~20% | yes | none | **yes** | universal |
| Inpatient hospital | coinsurance ~20% | yes | none | **yes** | universal |
| Mental health — outpatient | copay (parity) | no | none (parity) | no | universal |
| Mental health — inpatient | coinsurance ~20% | yes | none | **yes** | universal |
| Physical/occupational/speech therapy | copay $25–$50 | no | **~20–60 visits/yr** | no | universal; visit cap is the most consistent limit |
| Chiropractic | copay ~$25 | no | **~$1,500/yr** (or visit cap) | no | common but variable |
| Skilled nursing facility | coinsurance ~20% | yes | **~25–180 days/yr** | **yes** | universal |
| Home health | coinsurance ~20% | yes | **~60–120 visits/yr** | yes | universal |
| Durable medical equipment | coinsurance ~20% | yes | quantity/replacement | sometimes | universal |
| Maternity / delivery | coinsurance ~20% (prenatal $0) | yes | none | no | universal |

## Dollar vs. visit limits (the key finding)

**Visit/day limits dominate** the categories where overuse is the concern — outpatient
rehab (PT/OT/ST ~20–60/yr, often a combined pool), home health (~60–120/yr), skilled
nursing (~25–180 days/yr). These are almost always expressed as a **count**, not dollars.
**Dollar limits are the minority** — chiropractic (~$1,500/yr), infertility, hearing aids.
Drug "limits" are supply windows (30/90-day), DME limits are replacement frequency.
→ **A single `annual_limit_cents` field can't represent the most common limit shape.** The
model needs a `limit.unit` discriminator.

## Common exclusions

Adult dental, adult routine vision/glasses, cosmetic surgery, long-term/custodial care,
weight-loss programs, routine foot care, acupuncture, hearing aids, bariatric surgery,
infertility, private-duty nursing, non-emergency care abroad, experimental/investigational,
not-medically-necessary services, OON care on HMO/EPO (except emergencies).

## Modeling implications (drove decisions #5–#7)

- Cost-share → discriminated union (`full_coverage | copay | coinsurance`); one per service.
- Limit → `{ unit: none | dollars | visits }`; accumulator `limit_used` in the same unit.
- `applies_deductible` kept explicit per rule (copay waives, coinsurance applies; exceptions exist).
- Two denial paths: explicit `excluded` → `EXCLUDED`; no rule → `NO_COVERAGE` (seed both).
- Prior-auth binary in v1; PPO reduce-to-50% penalty noted as a known divergence.

## Key citations

- UnitedHealthcare Choice Plus PPO SBC (2024) — $750 deductible, 15–20% coinsurance, $15 PCP copay, $100 ER, 90-visit home health, DME 1-per-type/3-yr.
- UHC/Aetna 2025 TX Gold 10 HMO SBC — $0 deductible, copay-driven, $550 MRI, $750 ER, 35-visit combined PT/OT/ST, 25-day SNF.
- Aetna 2025 SBCs (IFP + State of Florida Standard HMO).
- Cigna Open Access Plus SBC (2024) — $500 deductible, $3,000 OOP, $25 copay, 20% coinsurance, $100 ER + coinsurance.
- healthcare.gov / CMS — ACA 10 essential health benefits, preventive at no cost-share, metal-tier actuarial values.
