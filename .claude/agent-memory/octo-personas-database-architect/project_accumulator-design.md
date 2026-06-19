---
name: project_accumulator-design
description: Accumulator stored as one table with a dimension discriminator handling both dollar and visit limits
metadata:
  type: project
---

The accumulator (the crux of this domain) is proposed as a SINGLE table keyed `(member_id, plan_year, dimension)` where `dimension` is `'DEDUCTIBLE' | 'OOP' | 'LIMIT:<service_code>'`, with columns `used_cents` (dollar dimensions) and `used_count` (visit limits, NULL otherwise).

The matching coverage_rule's `limit_unit` tells the engine which column to read/increment: dollars -> used_cents, visits -> used_count. Limit rows created lazily (upsert on first use), not pre-seeded.

Storage note: the `cost_share`/`limit` discriminated unions and `reasons[]` array (TS-level, in [[project_claims-takehome]]) are flattened for SQLite — typed nullable columns + discriminator for the unions, JSON TEXT for reasons[]. The src/schemas validators reconstruct on read.

**Why:** one accumulator table = one writeback code path / one upsert / one read query; the discriminator costs nothing. Avoids three separate accumulator tables.
**How to apply:** if re-engaged on this repo's schema, reuse this shape rather than re-deriving; check the actual migration/schema files first since the build may have diverged.
