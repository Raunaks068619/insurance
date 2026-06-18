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
pnpm dev          # start the API on http://localhost:3000
```

> Requires Node 20+ and pnpm. SQLite is embedded (better-sqlite3) — no database server to
> install or run.

## Demo (the 4 endpoints)

> Endpoint shapes are defined in `PRD.md`. Bodies below are illustrative; adjust to the
> seeded ids once the API lands.

```bash
# 1. Submit a claim with line items → runs adjudication, returns per-line results
curl -s -X POST http://localhost:3000/claims \
  -H 'content-type: application/json' \
  -d '{
        "memberId": "m_001",
        "lineItems": [
          { "serviceCode": "OFFICE_VISIT", "billedCents": 20000, "serviceDate": "2026-03-01" },
          { "serviceCode": "MRI",          "billedCents": 120000, "serviceDate": "2026-03-01", "priorAuthPresent": false }
        ]
      }' | jq

# 2. Fetch a claim with its line items, statuses, payable amounts
curl -s http://localhost:3000/claims/clm_001 | jq

# 3. Get the full explanation (reason code + rule + numbers per line item)
curl -s http://localhost:3000/claims/clm_001/explanation | jq

# 4. Dispute a line-item decision → reopens it, preserves the original
curl -s -X POST http://localhost:3000/claims/clm_001/line-items/li_002/dispute \
  -H 'content-type: application/json' \
  -d '{ "reason": "Prior auth was actually obtained" }' | jq
```

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
