// app/src/db/seed.ts — insert the reference world (member + active 2026 policy + coverage rules).
//
// The insertion logic is copied verbatim from app/tests/db-helpers.ts seedWorld(), so the file DB
// holds exactly the same fixtures the DB tests run against. Idempotent: if the member already
// exists (a previous boot already seeded), it returns without re-inserting — the file DB persists
// between runs and these ids are fixed, so a blind re-insert would violate the PK.
//
// Runnable standalone (`pnpm seed`): opens the file DB, applies the schema, seeds, and exits.

import { eq } from "drizzle-orm";
import { type Db, createDb } from "./connection";
import { applySchema } from "./migrate";
import { coverageRules, members, policies } from "./schema";
import type { CoverageRule } from "../domain/types";

type SeedRule = Partial<CoverageRule> & { serviceCode: string };

export type SeedIds = { memberId: string; policyId: string; planYear: string };

// Service codes come from the CLOSED 12-entry catalog enforced by ck_cr_service_code in schema.sql.
const DEFAULT_RULES: SeedRule[] = [
  // PCP visit — $25 copay, applies to the deductible. (APPROVED path)
  {
    serviceCode: "PCP_VISIT",
    costShare: { type: "copay", copayCents: 2_500 },
    appliesDeductible: true,
  },
  // Physical therapy — 20% coinsurance, capped at 20 visits/year, NEEDS prior auth.
  // Submit a line with priorAuthPresent:false → DENIED (PRIOR_AUTH_REQUIRED). (denial path)
  {
    serviceCode: "PHYSICAL_THERAPY",
    costShare: { type: "coinsurance", rate: 0.2 },
    appliesDeductible: true,
    limit: { unit: "visits", count: 20 },
    requiresPriorAuth: true,
  },
  // Preventive screening — fully covered, no member cost. (APPROVED path)
  {
    serviceCode: "PREVENTIVE",
    costShare: { type: "full_coverage" },
  },
  // Adult dental — explicitly EXCLUDED. Any line for it → DENIED (EXCLUDED). (denial path)
  {
    serviceCode: "ADULT_DENTAL",
    covered: false,
    excluded: true,
  },
];

// Insert a member + an active 2026 policy + coverage rules. Returns the ids a claim needs.
// (Insertion logic copied verbatim from seedWorld in app/tests/db-helpers.ts.)
export function seed(
  db: Db,
  opts: {
    deductibleCents?: number;
    oopMaxCents?: number;
    rules?: SeedRule[];
  } = {},
): SeedIds {
  const memberId = "mem_seed_1";
  const policyId = "pol_seed_1";
  const planYear = "2026";

  const existing = db
    .select()
    .from(members)
    .where(eq(members.id, memberId))
    .all();
  if (existing.length > 0) return { memberId, policyId, planYear };

  const rules = opts.rules ?? DEFAULT_RULES;

  db.insert(members)
    .values({ id: memberId, name: "Jane Doe", dob: "1990-05-01" })
    .run();
  db.insert(policies)
    .values({
      id: policyId,
      memberId,
      planYear,
      effectiveDate: "2026-01-01",
      terminationDate: "2026-12-31",
      deductibleCents: opts.deductibleCents ?? 50_000,
      oopMaxCents: opts.oopMaxCents ?? 300_000,
    })
    .run();

  rules.forEach((r, i) => {
    const costShare = r.costShare ?? { type: "full_coverage" };
    const limit = r.limit ?? { unit: "none" };
    db.insert(coverageRules)
      .values({
        id: `cr_seed_${i}`,
        policyId,
        serviceCode: r.serviceCode,
        covered: r.covered ?? true,
        excluded: r.excluded ?? false,
        costShareType: costShare.type,
        copayCents: costShare.type === "copay" ? costShare.copayCents : null,
        coinsuranceRate:
          costShare.type === "coinsurance" ? costShare.rate : null,
        appliesDeductible: r.appliesDeductible ?? false,
        limitUnit: limit.unit,
        limitAmountCents: limit.unit === "dollars" ? limit.amountCents : null,
        limitCount: limit.unit === "visits" ? limit.count : null,
        requiresPriorAuth: r.requiresPriorAuth ?? false,
      })
      .run();
  });

  return { memberId, policyId, planYear };
}

// CLI entry: `pnpm seed` (DB_PATH overridable). Applies the schema first so it works on a fresh DB.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.DB_PATH ?? "./claims.db";
  const { db, sqlite } = createDb(dbPath);
  applySchema(sqlite);
  const ids = seed(db);
  sqlite.close();
  console.log(`seeded ${dbPath}:`, ids);
}
