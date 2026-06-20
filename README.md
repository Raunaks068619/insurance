# Claims Processing System

A health-insurance claims adjudication engine. Submit a claim, get a per-line decision with
explanations, track the lifecycle, and dispute any decision.

Built for the Realfast FDE Level-1 take-home.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 22+ | https://nodejs.org |
| pnpm | any | `npm install -g pnpm` |
| jq | any | `brew install jq` (for formatting curl output) |

SQLite is **embedded** — no database server needed.

---

## Setup

```bash
pnpm install   # install dependencies
pnpm start     # seeds the DB automatically, then starts the API on http://localhost:3000
```

That's it. `pnpm start` runs the seed on every boot (idempotent — safe to restart).

```bash
pnpm test      # run the full test suite (62 tests, all domain behavior)
```

---

## The 3 Endpoints

| Method | Path | What it does |
|---|---|---|
| `POST` | `/claims` | Submit a claim → adjudicates every line → returns decisions |
| `GET` | `/claims/:id` | Fetch a claim: status, per-line decisions, amounts, lifecycle timeline |
| `POST` | `/claims/:id/line-items/:lid/dispute` | Dispute one line with corrected facts → re-adjudicates |

---

## How the System Works

### 1. Policy

Every member has one policy for the plan year. It sets three numbers:

| Field | Seeded default | Meaning |
|---|---|---|
| Deductible | $500 | Member pays this first before coinsurance kicks in |
| OOP max | $3,000 | Maximum a member pays in a year — plan absorbs 100% above this |
| Plan year | 2026-01-01 to 2026-12-31 | Service dates outside this window are denied |

---

### 2. Coverage Rules

Each policy has one coverage rule per service. A rule controls three things:

**Is the service covered?**

| Situation | Result |
|---|---|
| Rule exists, `covered = true` | Covered — proceed to cost-share |
| Rule exists, `excluded = true` | Denied — `EXCLUDED` |
| No rule for this service | Denied — `NO_COVERAGE` |

**How is cost split? (exactly one of three mechanisms)**

| Mechanism | How it works | Deductible? | Example on a $1,000 bill |
|---|---|---|---|
| **Full coverage** | Plan pays 100% | No | Member pays $0, plan pays $1,000 |
| **Copay** | Member pays a flat fee, plan pays the rest | No — copay skips deductible | $25 copay → member $25, plan $975 |
| **Coinsurance** | Member pays a % after deductible | Yes — deductible drawn first | 20% rate, $500 deductible unmet → member pays $500 deductible + 20% of remaining $500 = $600 total, plan pays $400 |

**Is there an annual limit?**

| Type | Example | What happens when hit |
|---|---|---|
| Visit cap | 12 chiro visits/year | 13th visit denied — `LIMIT_EXCEEDED` |
| Dollar cap | $1,500/year | Amount over the cap denied — `LIMIT_EXCEEDED` |
| None | Most services | No cap |

---

### 3. Claim Intake

`POST /claims` accepts:

```json
{
  "memberId": "string",
  "serviceDate": "YYYY-MM-DD",
  "lineItems": [
    {
      "serviceCode": "PCP_VISIT",
      "billedCents": 20000,
      "units": 1,
      "priorAuthPresent": true
    }
  ]
}
```

**Intake rejects (HTTP 400 — nothing persisted):**
- Unknown `memberId` (member has no policy on file)
- Missing or malformed fields
- `billedCents` not a positive integer
- `serviceDate` in the future or invalid format

**Adjudication denials (HTTP 201 — processed, reason explained):**
- `POLICY_NOT_ACTIVE`, `NO_COVERAGE`, `EXCLUDED`, `PRIOR_AUTH_REQUIRED`, `LIMIT_EXCEEDED`
- A denied line is a processed decision, not an error

> `priorAuthPresent` defaults to `true` when omitted. Send `false` explicitly to trigger `PRIOR_AUTH_REQUIRED`.

**Accepted service codes (12):**
`PREVENTIVE` · `PCP_VISIT` · `SPECIALIST_VISIT` · `URGENT_CARE` · `EMERGENCY_ROOM` · `LAB` · `MRI` · `OUTPATIENT_SURGERY` · `INPATIENT_HOSPITAL` · `PHYSICAL_THERAPY` · `CHIROPRACTIC` · `ADULT_DENTAL`

---

### 4. Adjudication Pipeline

Every line item goes through this pipeline in order. First failed gate stops processing for that line.

| Step | Check | Denied with |
|---|---|---|
| 1 | Is this a duplicate of an already-adjudicated line? | `DUPLICATE_LINE_ITEM` |
| 2 | Is the policy active on the service date? | `POLICY_NOT_ACTIVE` |
| 3 | Does a coverage rule exist for this service? | `NO_COVERAGE` |
| 4 | Is the service covered and not excluded? | `EXCLUDED` or `NO_COVERAGE` |
| 5 | Is prior auth satisfied (if required)? | `PRIOR_AUTH_REQUIRED` |
| 6 | Is there annual limit remaining? | `LIMIT_EXCEEDED` |
| 7 | Apply cost-share (full / copay / coinsurance + deductible draw) | — |
| 8 | Apply OOP cap (member never pays beyond their annual max) | `OOP_MAX_REACHED` |

**Money invariant:** `memberResponsibilityCents + payableCents = billedCents` on every approved line. Enforced by always computing `plan = allowed − member` last — never loses a cent to rounding.

**Claim status** is derived from line outcomes:

| Line results | Claim status |
|---|---|
| All lines approved | `APPROVED` |
| All lines denied | `DENIED` |
| Mix of approved + denied, or any dollar-limit straddle | `PARTIALLY_APPROVED` |
| Any line reopened by a dispute | `UNDER_REVIEW` |

Every status change is recorded in an append-only `timeline` (visible on `GET /claims/:id`).

---

### 5. Dispute Flow

A member can dispute any terminal line (`APPROVED` or `DENIED`) by supplying corrected facts.

```
POST /claims/:id/line-items/:lid/dispute
{
  "reason": "Prior authorization was on file",
  "corrected": {
    "priorAuthPresent": true   ← overrides the original value
  }
}
```

**What corrected facts can change:** `priorAuthPresent`, `serviceCode`, `billedCents`, `units`.

**What happens:**
1. Line moves `APPROVED/DENIED → NEEDS_REVIEW`; claim moves to `UNDER_REVIEW`
2. System re-adjudicates the line with the corrected facts against current rules
3. Accumulators are net-out (original deltas reversed, new deltas applied) — no double-counting
4. Original decision is preserved immutably; a new decision is appended
5. Outcome is one of: `OVERTURNED`, `UPHELD`, `PARTIALLY_OVERTURNED`, `MODIFIED`
6. Line and claim settle back to their new terminal status

**Guards:**
- Line not found → `404`
- Line not yet terminal (`PENDING` / `NEEDS_REVIEW`) → `409`
- No corrected facts → outcome is `UPHELD` (re-running identical inputs is a no-op)

---

## Test Flows — All 10 Scenarios

The server seeds 10 members on startup. Each covers one adjudication path. Run `pnpm start` first, then use the curls below.

---

### Flow 1 — Happy path: copay approval

**Member:** `mem_approved` · Rule: PCP_VISIT = $25 copay

```bash
curl -s -X POST http://localhost:3000/claims \
  -H 'content-type: application/json' \
  -d '{
    "memberId": "mem_approved",
    "serviceDate": "2026-06-01",
    "lineItems": [{ "serviceCode": "PCP_VISIT", "billedCents": 20000 }]
  }' | jq '{status, totalPayableCents, line: .lineItems[0] | {status, payableCents, memberResponsibilityCents, reasons, explanation}}'
```

**Expected:** `APPROVED` · plan pays $175 · member owes $25 copay · `COPAY_APPLIED`

---

### Flow 2 — Prior auth denial

**Member:** `mem_prior_auth` · Rule: MRI requires prior auth

```bash
curl -s -X POST http://localhost:3000/claims \
  -H 'content-type: application/json' \
  -d '{
    "memberId": "mem_prior_auth",
    "serviceDate": "2026-06-01",
    "lineItems": [{ "serviceCode": "MRI", "billedCents": 100000, "priorAuthPresent": false }]
  }' | jq '{status, line: .lineItems[0] | {status, payableCents, reasons, explanation}}'
```

**Expected:** `DENIED` · plan pays $0 · `PRIOR_AUTH_REQUIRED`

---

### Flow 3 — Excluded service

**Member:** `mem_excluded` · Rule: ADULT_DENTAL is excluded

```bash
curl -s -X POST http://localhost:3000/claims \
  -H 'content-type: application/json' \
  -d '{
    "memberId": "mem_excluded",
    "serviceDate": "2026-06-01",
    "lineItems": [{ "serviceCode": "ADULT_DENTAL", "billedCents": 8000 }]
  }' | jq '{status, line: .lineItems[0] | {status, payableCents, reasons, explanation}}'
```

**Expected:** `DENIED` · plan pays $0 · `EXCLUDED`

---

### Flow 4 — No coverage rule

**Member:** `mem_no_coverage` · LAB has no rule on this member's policy

```bash
curl -s -X POST http://localhost:3000/claims \
  -H 'content-type: application/json' \
  -d '{
    "memberId": "mem_no_coverage",
    "serviceDate": "2026-06-01",
    "lineItems": [{ "serviceCode": "LAB", "billedCents": 5000 }]
  }' | jq '{status, line: .lineItems[0] | {status, payableCents, reasons, explanation}}'
```

**Expected:** `DENIED` · plan pays $0 · `NO_COVERAGE`

---

### Flow 5 — Policy not active

**Member:** `mem_inactive` · Policy ran 2025-01-01 to 2025-12-31

```bash
curl -s -X POST http://localhost:3000/claims \
  -H 'content-type: application/json' \
  -d '{
    "memberId": "mem_inactive",
    "serviceDate": "2026-06-01",
    "lineItems": [{ "serviceCode": "PCP_VISIT", "billedCents": 15000 }]
  }' | jq '{status, line: .lineItems[0] | {status, payableCents, reasons, explanation}}'
```

**Expected:** `DENIED` · plan pays $0 · `POLICY_NOT_ACTIVE`

---

### Flow 6 — Visit limit exhausted

**Member:** `mem_limit` · CHIROPRACTIC has 12-visit cap; 12/12 already used

```bash
curl -s -X POST http://localhost:3000/claims \
  -H 'content-type: application/json' \
  -d '{
    "memberId": "mem_limit",
    "serviceDate": "2026-06-01",
    "lineItems": [{ "serviceCode": "CHIROPRACTIC", "billedCents": 10000 }]
  }' | jq '{status, line: .lineItems[0] | {status, payableCents, reasons, explanation}}'
```

**Expected:** `DENIED` · plan pays $0 · `LIMIT_EXCEEDED`

---

### Flow 7 — Deductible draw + coinsurance

**Member:** `mem_deductible` · SPECIALIST_VISIT = 30% coinsurance · deductible $500 (unmet)

```bash
curl -s -X POST http://localhost:3000/claims \
  -H 'content-type: application/json' \
  -d '{
    "memberId": "mem_deductible",
    "serviceDate": "2026-06-01",
    "lineItems": [{ "serviceCode": "SPECIALIST_VISIT", "billedCents": 80000 }]
  }' | jq '{status, line: .lineItems[0] | {status, payableCents, memberResponsibilityCents, reasons, explanation}}'
```

**Expected:** `APPROVED` · bill $800 · member pays $500 deductible + $90 coinsurance (30% of $300 remainder) = $590 · plan pays $210 · `DEDUCTIBLE_APPLIED, COINSURANCE_APPLIED`

---

### Flow 8 — OOP maximum reached

**Member:** `mem_oop` · $2,900 of $3,000 OOP already met · SPECIALIST_VISIT = 50% coinsurance

```bash
curl -s -X POST http://localhost:3000/claims \
  -H 'content-type: application/json' \
  -d '{
    "memberId": "mem_oop",
    "serviceDate": "2026-06-01",
    "lineItems": [{ "serviceCode": "SPECIALIST_VISIT", "billedCents": 100000 }]
  }' | jq '{status, line: .lineItems[0] | {status, payableCents, memberResponsibilityCents, reasons, explanation}}'
```

**Expected:** `APPROVED` · bill $1,000 · 50% = $500 member share, but OOP only has $100 left → member pays $100, plan pays $900 · `OOP_MAX_REACHED`

---

### Flow 9 — Partial approval (mixed claim)

**Member:** `mem_partial` · Three lines: PCP_VISIT (copay), PREVENTIVE (full), ADULT_DENTAL (excluded)

```bash
curl -s -X POST http://localhost:3000/claims \
  -H 'content-type: application/json' \
  -d '{
    "memberId": "mem_partial",
    "serviceDate": "2026-06-01",
    "lineItems": [
      { "serviceCode": "PCP_VISIT",     "billedCents": 20000 },
      { "serviceCode": "PREVENTIVE",    "billedCents": 15000 },
      { "serviceCode": "ADULT_DENTAL",  "billedCents": 8000  }
    ]
  }' | jq '{status, totalPayableCents, lineItems: [.lineItems[] | {serviceCode, status, payableCents, reasons}]}'
```

**Expected:** `PARTIALLY_APPROVED` · PCP_VISIT → APPROVED ($25 copay, plan $175) · PREVENTIVE → APPROVED (plan $150) · ADULT_DENTAL → DENIED ($0)

---

### Flow 10 — Intake reject (no policy)

**Member:** `mem_no_policy` · No policy on file → 400, nothing stored

```bash
curl -s -X POST http://localhost:3000/claims \
  -H 'content-type: application/json' \
  -d '{
    "memberId": "mem_no_policy",
    "serviceDate": "2026-06-01",
    "lineItems": [{ "serviceCode": "PCP_VISIT", "billedCents": 20000 }]
  }' | jq .
```

**Expected:** HTTP `400` · `{ "errors": [{ "field": "memberId", "code": "NO_ACTIVE_POLICY", ... }] }`

---

## Explanation Flow

Per-line explanation (reason codes + plain-English sentence) is included in every response. No separate endpoint needed.

```bash
# 1. Submit and read explanation inline
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

echo "$CLAIM" | jq '.lineItems[] | {serviceCode, status, reasons, explanation}'

# 2. Or fetch any existing claim and read explanations from it
CLAIM_ID=$(echo "$CLAIM" | jq -r '.id')
curl -s "http://localhost:3000/claims/$CLAIM_ID" \
  | jq '{status, timeline: [.timeline[] | {reason, toStatus}], lineItems: [.lineItems[] | {serviceCode, status, reasons, explanation}]}'
```

---

## Dispute Flow

```bash
# Step 1 — submit MRI without prior auth → DENIED
CLAIM=$(curl -s -X POST http://localhost:3000/claims \
  -H 'content-type: application/json' \
  -d '{
    "memberId": "mem_prior_auth",
    "serviceDate": "2026-06-01",
    "lineItems": [{ "serviceCode": "MRI", "billedCents": 100000, "priorAuthPresent": false }]
  }')

echo "Initial:" && echo "$CLAIM" | jq '{status, line: .lineItems[0] | {status, payableCents, reasons}}'

CLAIM_ID=$(echo "$CLAIM" | jq -r '.id')
LINE_ID=$(echo "$CLAIM"  | jq -r '.lineItems[0].lineItemId')

# Step 2 — dispute: supply the missing auth → OVERTURNED
DISPUTE=$(curl -s -X POST "http://localhost:3000/claims/$CLAIM_ID/line-items/$LINE_ID/dispute" \
  -H 'content-type: application/json' \
  -d '{ "reason": "Prior authorization was on file", "corrected": { "priorAuthPresent": true } }')

echo "Dispute outcome:" && echo "$DISPUTE" | jq '{outcome, claim: {status: .claim.status, totalPayableCents: .claim.totalPayableCents}}'
echo "Updated line:"    && echo "$DISPUTE" | jq '.claim.lineItems[0] | {status, payableCents, memberResponsibilityCents, reasons}'
```

**Expected after dispute:** `outcome: OVERTURNED` · line `APPROVED` · plan pays $400 (20% coinsurance on $500 remainder after $500 deductible draw)

---

## Member Reference

| # | Member | Policy | Coverage rule | Pre-seeded state |
|---|---|---|---|---|
| 1 | `mem_approved` | Default ($500 ded, $3k OOP) | PCP_VISIT = $25 copay; PREVENTIVE = full | — |
| 2 | `mem_prior_auth` | Default | MRI = 20% coinsurance, requires prior auth | — |
| 3 | `mem_excluded` | Default | ADULT_DENTAL = excluded | — |
| 4 | `mem_no_coverage` | Default | PCP_VISIT only — LAB has no rule | — |
| 5 | `mem_inactive` | 2025-01-01 to 2025-12-31 | PCP_VISIT = $25 copay | — |
| 6 | `mem_limit` | Default | CHIROPRACTIC = 20% coinsurance, 12 visits/yr | 12/12 visits used |
| 7 | `mem_deductible` | $500 ded, $3k OOP | SPECIALIST_VISIT = 30% coinsurance after ded | — |
| 8 | `mem_oop` | $3k OOP | SPECIALIST_VISIT = 50% coinsurance, no ded | $2,900 of $3,000 OOP met |
| 9 | `mem_partial` | Default | PCP_VISIT = $25 copay; PREVENTIVE = full; ADULT_DENTAL = excluded | — |
| 10 | `mem_no_policy` | None | None | — |

---

## Recommended Reading Order

| Order | File | What it covers |
|---|---|---|
| 1 | `docs/domain-model.md` | Entities, state machines, worked numeric examples |
| 2 | `docs/decisions.md` | What was built, what was skipped, and why |
| 3 | `docs/self-review.md` | Honest gap-list and confidence calibration |
| 4 | `app/src/domain/adjudication/adjudicator.ts` | The core engine (pure function, 235 lines) |
| 5 | `app/tests/adjudicate-line.test.ts` | 21 unit tests — the domain behavior spec |
| 6 | `app/src/` | Services, repositories, HTTP layer |
| 7 | `ai-artifacts/` | Raw JSONL session logs by phase |

---

## Stack

| Tool | Why |
|---|---|
| TypeScript (strict) + Node 22 | Types encode the domain; strict mode catches money/null bugs at compile time |
| vitest | Fast test-first loop with native TypeScript support |
| fastify | Minimal, typed HTTP layer for three endpoints |
| SQLite (better-sqlite3) | Zero-setup persistence; synchronous driver keeps adjudication deterministic |
| drizzle-orm | Type-safe query builder mirroring the canonical SQL schema |
| biome | Lint + format in one tool, zero config |
| pnpm | Fast, deterministic installs |

---

## Project Layout

```
app/src/
  domain/          pure core — types + adjudicator + aggregator (no infrastructure)
  services/        business logic — claim service, dispute service, read service
  repositories/    data access — one repo per table
  controllers/     HTTP ↔ domain translation (thin)
  routes/          URL + method → handler wiring
  db/              schema, migrations, connection factory, seed

app/tests/         behavior specs — domain unit tests + HTTP integration tests

docs/
  domain-model.md  entities, state machines, worked examples
  decisions.md     21 numbered decisions with rationale
  self-review.md   honest gap-list

ai-artifacts/      raw JSONL session logs (01-framing through 07-qa)
project-docs/      original assignment brief (do not edit)
```
