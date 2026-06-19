---
name: project_claims-takehome
description: Claims-adjudication take-home — locked stack, constraints, and what's deferred for the data layer
metadata:
  type: project
---

This repo is a Forward Deployed Engineer take-home (Level 1): build a Claims Processing System. 24-48h budget.

**Locked decisions (in docs/decisions.md, PRD.md — verify before relying):**
- Persistence: SQLite via better-sqlite3, synchronous single-writer. No Postgres/Docker.
- Money: integer cents everywhere, never floats. Round half-up only at the final cents where a percentage applies.
- Adjudication rows are immutable / append-only; re-adjudication (dispute) preserves the original and appends a new row.
- Reimbursement model: money flows plan -> member (not plan -> provider). PAID via explicit settle action.
- `member_id` is opaque; engine keys on it only, never reads PHI.
- Coverage rule `cost_share` = discriminated union (full_coverage|copay|coinsurance); `limit` = unit-typed (none|dollars|visits).
- Closed 12-entry service_code catalog; unlisted -> NO_COVERAGE at adjudication.
- Intake reject = HTTP 4xx, nothing persisted (no REJECTED state). Member existence rejects at intake; policy active-on-date denies at adjudication.

**Deferred / kept simple for v1:** dispute table (use a new adjudication row instead), payment ledger (status + paid_at), real encryption (document-not-built).

**Still open (as of 2026-06-19):** C3 adjudication engine behavior (the big one — step order, prior-auth NEEDS_REVIEW routing, reasons[] population, atomic writeback). A System Architect owns the runtime algorithm; this persona owns storage.

**Why:** rubric rewards domain decomposition, rule representation, edge-case thinking, explanation — not infra. Building infra/crypto burns budget for zero points.
**How to apply:** keep data-layer proposals minimal and aligned to these locks; flag anything that deviates rather than silently changing the model.
