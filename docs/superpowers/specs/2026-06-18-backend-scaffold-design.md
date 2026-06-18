# Backend Scaffold — Structuring Design

**Date:** 2026-06-18
**Status:** Approved (structure) — pending spec review
**Scope:** Folder structure + module boundaries for the claims-processing backend in `app/`.
This is a *structuring* spec, not the domain spec. Domain rules live in
[`docs/domain-model.md`](../../domain-model.md) and the `insurance-domain` skill; decisions
in [`docs/decisions.md`](../../decisions.md).

## Goal

Stand up a TypeScript + Node + Express + Swagger backend skeleton in `app/` whose shape
mirrors the team's reference layout (`Raunaks068619/assessment/backend/src`) but is adapted
to the claims domain: a layered HTTP/persistence shell wrapped around a **pure, I/O-free
domain core** that holds the adjudication engine.

## Decisions feeding this spec

| # | Decision | Source |
|---|----------|--------|
| Stack | TypeScript (strict) + Node 20 + Express + Swagger; vitest for tests | Decision #1 + this session |
| Datastore | **SQLite** (`better-sqlite3`, synchronous). *Postgres considered and rejected this session* — reverses no decision; zero-setup clone-and-run + deterministic writeback win. | Decision #2 (re-confirmed) |
| Rules | **Typed config + JSON. No DSL, no pluggable engine.** Rules authored as JSON, validated against the TS schema, seeded into SQLite as `CoverageRule` rows tied to a policy. | Decision #3 + this session |
| Money | Integer cents everywhere, explicit rounding | Decision #4 |
| Cost-share | Discriminated union `full_coverage \| copay \| coinsurance` | Decision #5 |
| Limits | Unit-typed `none \| dollars \| visits` | Decision #6 |
| Folder naming | All-plural layer folders (`controllers/`, not the reference's singular `controller/`) | This session |

## Architecture: layered shell + pure domain core (Option C)

The HTTP edge (`routes → controllers → services`) and the persistence edge
(`repositories → db`) surround `domain/`, which has **zero Express and zero SQLite imports**.
The adjudication engine is a pure function of `(LineItem, CoverageRule, Accumulator snapshot)`
→ `Adjudication`, making it deterministic and unit-testable in isolation — which the rubric
(domain decomposition, rule representation, explanation) rewards and which `TRACK.md`'s
test-first mandate requires.

**Dependency direction:** `domain/` depends on nothing internal. `services/` and
`repositories/` depend on `domain/`. `controllers/`/`routes/` depend on `services/`.
Nothing in `domain/` imports outward.

## Folder structure (`app/`)

```
app/
├── src/
│   ├── index.ts                 # bootstrap: load+seed rules, open DB, start server
│   ├── app.ts                   # express wiring: routers + swagger + error mw
│   ├── config/
│   │   └── env.ts               # PORT, DB path, plan-year defaults
│   │
│   ├── domain/                  # ── PURE CORE: no express, no sqlite ──
│   │   ├── entities/            # Member, Policy, CoverageRule, Claim,
│   │   │                        #   LineItem, Adjudication, Accumulator, Dispute (TS types)
│   │   ├── reason-codes.ts      # ReasonCode enum
│   │   ├── money/
│   │   │   └── cents.ts         # integer-cents math + deterministic rounding
│   │   ├── rules/
│   │   │   ├── coverage-rule.ts # discriminated unions: cost_share, limit
│   │   │   ├── rule-schema.ts   # zod schema → validates JSON rules
│   │   │   └── rule-loader.ts   # validate + map parsed JSON → typed records (pure; fs read lives in db/seed.ts)
│   │   ├── adjudication/        # ── THE "RULE ENGINE" (deterministic, typed) ──
│   │   │   ├── adjudicator.ts   # canonical order, short-circuit denials
│   │   │   ├── cost-share.ts    # switch: full_coverage | copay | coinsurance
│   │   │   └── limits.ts        # none | dollars(straddle) | visits
│   │   └── state-machines/
│   │       ├── claim-state.ts   # SUBMITTED→UNDER_REVIEW→…→PAID + guards
│   │       └── line-item-state.ts
│   │
│   ├── controllers/             # HTTP handlers: parse → call service → shape response
│   ├── services/                # orchestration: submitClaim, openDispute, getExplanation
│   ├── repositories/            # SQLite persistence (claims, adjudications, accumulators)
│   ├── routes/                  # express routers: claims, disputes, policies (read)
│   ├── middlewares/
│   │   ├── schema-validation.ts # request validation (zod)
│   │   └── error-handler.ts
│   ├── db/
│   │   ├── connection.ts        # better-sqlite3 singleton
│   │   ├── migrate.ts           # create tables
│   │   └── seed.ts              # load JSON rules + sample member/policy
│   ├── docs/
│   │   └── openapi.ts           # swagger-ui-express + spec, served at /docs
│   └── utils/                   # generic helpers
│
├── rules/                       # JSON coverage-rule config (authored, validated on load)
│   └── *.json
└── tests/                       # vitest: domain unit tests + api integration tests
```

## Module responsibilities

- **`domain/adjudication/` (the rule engine).** Pure functions implementing the canonical
  adjudication order from the `insurance-domain` skill: active → rule exists → covered →
  prior-auth → limit → cost-share switch → OOP cap → writeback intent. Reads typed
  `CoverageRule` records; no DB, no HTTP, no DSL.
- **`domain/rules/`.** The typed `CoverageRule` discriminated unions, a zod schema that
  validates author-supplied JSON, and a loader that maps validated (already-parsed) JSON
  into typed records. The loader is pure — the filesystem read of `app/rules/*.json` lives
  in `db/seed.ts`, so the domain core imports no `fs`.
- **`domain/state-machines/`.** Explicit transition tables + guards for claim and line-item
  lifecycles; illegal transitions throw.
- **`services/`.** Orchestrate use cases (submit claim, open dispute, fetch explanation):
  read accumulators via repos, call the pure adjudicator, persist results atomically.
- **`repositories/`.** The only place that talks SQLite. Maps rows ↔ domain entities.
- **`controllers/` + `routes/`.** Thin HTTP layer; validation via `middlewares/`.
- **`db/seed.ts`.** Reads `app/rules/*.json` → validates → inserts `CoverageRule` rows + a
  sample member/policy so the system runs immediately after clone.

## Rule + data flow

```
app/rules/*.json ──(rule-schema.ts: zod validate)──► typed CoverageRule[]
        │                                                   │
        └──────────────── db/seed.ts ──────────────────────► SQLite (coverage_rule rows, per policy)
                                                            │
POST /claims ─► controller ─► service ─► repo.readRules+accumulator ─► adjudicator (pure)
                                              │                              │
                                              ◄──── Adjudication[] ──────────┘
                                              └─► repo.persist (append-only adj + accumulator writeback)
```

## Out of scope for this scaffold

Auth, registration, enrollment, notifications, dashboards, admin panels, multi-tenant —
all explicitly out of scope per the brief. No rules DSL/engine abstraction (Decision #3).
No Postgres. No actual endpoint logic yet — this spec defines *where code goes*, not the
code; behavior arrives test-first via `/tdd-cycle`.

## Verification

- `npm run build` (tsc strict) compiles the skeleton with no errors.
- `npm run dev` starts the server; `GET /docs` serves Swagger UI.
- `npm test` runs (vitest green on a trivial bootstrap test).
- Directory tree matches the structure above.
