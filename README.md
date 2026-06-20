# Claims Processing System

A health-insurance claims adjudication system: submit a claim with line items, adjudicate
each line against the member's coverage rules, track claim and line-item lifecycles, and
explain every decision. Members can dispute a line-item decision.

Built for the Realfast FDE Level-1 take-home. The interface is a small REST API whose only
job is to demonstrate the domain.

## Quick start

```bash
pnpm install      # install dependencies
pnpm seed         # create the SQLite DB and load demo members, policies, rules
pnpm test         # run the vitest suite (tests encode the domain rules)
pnpm start        # start the API on http://localhost:3000
```

> Requires Node 22+ and pnpm. SQLite is embedded (better-sqlite3) — no database server to
> install or run.

## How the system is structured

### The policy

Every member has one active policy for the 2026 plan year. A policy sets three numbers:

| Field | Default | What it means |
|---|---|---|
| Deductible | $500 | Amount the member must pay out-of-pocket before coinsurance kicks in |
| OOP max | $3,000 | The most the member ever pays in a year — plan absorbs 100% above this |
| Plan year | 2026-01-01 → 2026-12-31 | Service dates outside this window are denied |

### Coverage rules

Each policy has a set of coverage rules — one per service type. A rule controls three things:

**1. Whether the service is covered**
- `covered = true` — the service is in the plan
- `excluded = true` — the service is explicitly carved out (e.g. adult dental)
- No rule on file — treated the same as not covered (`NO_COVERAGE`)

**2. How cost is shared between the plan and the member**

| Type | How it works | Deductible applies? | Example (on a $200 bill) |
|---|---|---|---|
| **Full coverage** | Plan pays 100%, member pays $0 | No | You pay $0, plan pays $200 |
| **Copay** | Member pays a flat fee; plan pays the rest | No — copay skips the deductible | $25 copay → you pay $25, plan pays $175 |
| **Coinsurance** | Member pays a percentage; plan pays the rest | Yes — deductible is drawn first, then percentage applies to what remains | 20% rate, $500 deductible unmet → you pay $200 deductible first; on a $1,000 bill you'd pay $500 + 20% of remaining $500 = $600, plan pays $400 |

> Full worked step-by-step examples with numbers: [`docs/domain-model.md` → Worked numeric examples](docs/domain-model.md).

**3. An optional annual limit**

| Type | Example |
|---|---|
| Visit cap | Chiropractic: 12 visits per year — 13th visit is denied |
| Dollar cap | $1,500/year — claims beyond the cap are denied |
| None | No limit (most services) |

### Service catalog

The system accepts 12 service codes. Any other code is denied as `NO_COVERAGE`.

| Code | Seeded cost-share (in demos) |
|---|---|
| `PREVENTIVE` | Full coverage — plan pays 100%, always free to the member |
| `PCP_VISIT` | Copay $25 |
| `SPECIALIST_VISIT` | Coinsurance 20–50% after deductible (varies by member) |
| `MRI` | Coinsurance 20% after deductible, requires prior auth |
| `CHIROPRACTIC` | Coinsurance 20%, 12-visit annual cap |
| `ADULT_DENTAL` | Excluded — always denied in the seed |
| `URGENT_CARE` · `EMERGENCY_ROOM` · `LAB` · `OUTPATIENT_SURGERY` · `INPATIENT_HOSPITAL` · `PHYSICAL_THERAPY` | Not assigned a rule in the seed — submit any of these to trigger `NO_COVERAGE` |

---

## Seeded member flows

`pnpm seed` loads 10 members, one per adjudication path. Every reason code the system can produce is covered by at least one unit test and one of these members.

| # | Member | What to submit | Reason code | Tests that cover it | Level |
|---|---|---|---|---|---|
| 1 | `mem_approved` | `PCP_VISIT`, any amount | `COPAY_APPLIED` | `adjudicate-line` → copay (2 tests) + `http-submit-claim` happy path | unit + HTTP |
| 2 | `mem_prior_auth` | `MRI` with `priorAuthPresent: false` | `PRIOR_AUTH_REQUIRED` | `adjudicate-line` → prior auth missing | unit |
| 3 | `mem_excluded` | `ADULT_DENTAL` | `EXCLUDED` | `adjudicate-line` → excluded service | unit |
| 4 | `mem_no_coverage` | `LAB` (no rule on file) | `NO_COVERAGE` | `adjudicate-line` → no rule + not-covered | unit |
| 5 | `mem_inactive` | `PCP_VISIT`, date in 2026 | `POLICY_NOT_ACTIVE` | `adjudicate-line` + `http-submit-resolution` (201) | unit + HTTP |
| 6 | `mem_limit` | `CHIROPRACTIC` (12/12 visits used) | `LIMIT_EXCEEDED` | `adjudicate-line` → visit limit denies | unit |
| 7 | `mem_deductible` | `SPECIALIST_VISIT`, `billedCents: 80000` | `DEDUCTIBLE_APPLIED` + `COINSURANCE_APPLIED` | `adjudicate-line` → coinsurance split (4 tests) | unit |
| 8 | `mem_oop` | `SPECIALIST_VISIT`, `billedCents: 100000` | `OOP_MAX_REACHED` | `adjudicate-line` → OOP maximum (2 tests) | unit |
| 9 | `mem_partial` | `PCP_VISIT` + `ADULT_DENTAL` + `PREVENTIVE` | `PARTIALLY_APPROVED` (claim-level) | `aggregate-claim` → some approve / some deny | unit |
| 10 | `mem_no_policy` | anything | `400` intake reject | `http-submit-resolution` → no policy | HTTP |

**Pre-seeded accumulator state** (members 6 and 8 arrive with prior usage already recorded):
- `mem_limit` — 12/12 chiropractic visits used, so the very next claim hits the cap immediately
- `mem_oop` — $2,900 of $3,000 OOP already met, so a $1,000 coinsurance line overflows to the cap

---

## Demo (the 3 endpoints)

`pnpm seed` loads a scenario matrix — one member per adjudication path. After seeding, run the
flows below. Claim and line-item IDs are UUIDs returned by the first `POST`; capture them with
`jq` as shown.

> The per-line explanation (reason codes + plain-English sentence) is included directly in both
> the `POST /claims` response and `GET /claims/:id` — there is no separate explanation endpoint.

### Scenario A — partial approval (PREVENTIVE approved + ADULT_DENTAL denied)

```bash
# Submit → PARTIALLY_APPROVED; response already contains per-line reasons + explanation
CLAIM=$(curl -s -X POST http://localhost:3000/claims \
  -H 'content-type: application/json' \
  -d '{
        "memberId": "mem_partial",
        "serviceDate": "2026-06-01",
        "lineItems": [
          { "serviceCode": "PREVENTIVE",   "billedCents": 15000 },
          { "serviceCode": "ADULT_DENTAL", "billedCents": 8000  }
        ]
      }')

# Claim status + per-line reasons and explanation
echo "$CLAIM" | jq '{status, totalPayableCents, lineItems: [.lineItems[] | {serviceCode, status, payableCents, reasons, explanation}]}'

CLAIM_ID=$(echo "$CLAIM" | jq -r '.id')

# Fetch the same claim later — includes the lifecycle timeline
curl -s "http://localhost:3000/claims/$CLAIM_ID" \
  | jq '{status, totalPayableCents, timeline: [.timeline[] | {reason, toStatus}], lineItems: [.lineItems[] | {serviceCode, status, reasons, explanation}]}'
```

### Scenario B — dispute overturns a prior-auth denial

```bash
# Submit MRI without prior auth → DENIED (PRIOR_AUTH_REQUIRED)
CLAIM=$(curl -s -X POST http://localhost:3000/claims \
  -H 'content-type: application/json' \
  -d '{
        "memberId": "mem_prior_auth",
        "serviceDate": "2026-06-01",
        "lineItems": [
          { "serviceCode": "MRI", "billedCents": 100000, "priorAuthPresent": false }
        ]
      }')
echo "$CLAIM" | jq '{status, lineItems: [.lineItems[] | {status, payableCents, reasons}]}'

CLAIM_ID=$(echo "$CLAIM" | jq -r '.id')
LINE_ID=$(echo "$CLAIM"  | jq -r '.lineItems[0].lineItemId')

# Dispute: supply the missing auth → OVERTURNED, line becomes APPROVED
curl -s -X POST "http://localhost:3000/claims/$CLAIM_ID/line-items/$LINE_ID/dispute" \
  -H 'content-type: application/json' \
  -d '{ "reason": "Prior authorization was on file", "corrected": { "priorAuthPresent": true } }' \
  | jq '{outcome, claim: {status: .claim.status, totalPayableCents: .claim.totalPayableCents}}'
```

### Other seeded scenarios (one `POST /claims` each)

| Member ID | Submit this | Expected outcome |
|---|---|---|
| `mem_approved` | `PCP_VISIT`, any `billedCents` | `APPROVED` — flat $25 copay |
| `mem_excluded` | `ADULT_DENTAL` | `DENIED` — `EXCLUDED` |
| `mem_no_coverage` | `LAB` | `DENIED` — `NO_COVERAGE` (no rule on file) |
| `mem_inactive` | `PCP_VISIT`, `serviceDate: "2026-01-01"` | `DENIED` — `POLICY_NOT_ACTIVE` (policy ends 2025) |
| `mem_limit` | `CHIROPRACTIC` | `DENIED` — `LIMIT_EXCEEDED` (12/12 visits pre-used) |
| `mem_deductible` | `SPECIALIST_VISIT`, `billedCents: 80000` | `APPROVED` — member owes deductible draw |
| `mem_oop` | `SPECIALIST_VISIT`, `billedCents: 100000` | `APPROVED` — `OOP_MAX_REACHED`, plan absorbs remainder |
| `mem_no_policy` | anything | `400` intake reject — no policy on file |

## Recommended reading order (for a reviewer)

1. `PRD.md` — the problem, the locked scope, the done-state, the domain primer.
2. `docs/domain-model.md` — entities, relationships, both state machines, adjudication order.
3. `docs/decisions.md` — what was built, what was skipped, and why.
4. `docs/self-review.md` — the honest gap-list.
5. `app/src` — the implementation (start at the adjudicator).
6. `app/tests` — the behavior specs (read these as the domain's executable definition).
7. `AGENTS.md` — how the work was governed (rules, TDD, session ritual).
8. `ai-artifacts/` — the raw JSONL trail, one folder per phase.
9. `TRACK.md` — the running log of focus, decisions, and hand-offs.

## Stack (one line each)

| Tool | Why |
|---|---|
| TypeScript (strict) + Node 20 | Types encode the domain; strict catches money/null bugs at compile time. |
| vitest | Fast test-first loop with native TS. |
| fastify | Minimal, typed HTTP for four endpoints. |
| SQLite (better-sqlite3) | Zero-setup persistence; clone and run. Synchronous → deterministic adjudication. |
| biome | Lint + format in one tool. |
| pnpm | Fast, deterministic installs. |

## Project layout

```
app/src        production code            docs/          the three deliverable docs
app/tests      behavior specs (first)     ai-artifacts/  raw JSONL per phase (01–07)
PRD.md         locked scope               AGENTS.md      rules & process (source of truth)
TRACK.md       live cross-session memory  project-docs/  original assignment brief
```
