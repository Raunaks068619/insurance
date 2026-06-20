// app/src/repositories/coverage-rule.repository.ts — coverage-rule reads per policy.
// Re-inflates the flat DB columns back into the CoverageRule discriminated unions.

import { eq } from "drizzle-orm";
import type { Db } from "../db/connection";
import { coverageRules } from "../db/schema";
import type { CostShare, CoverageLimit, CoverageRule } from "../domain/types";

type RuleRow = typeof coverageRules.$inferSelect;

function rowToCoverageRule(row: RuleRow): CoverageRule {
  const costShare: CostShare =
    row.costShareType === "copay"
      ? { type: "copay", copayCents: row.copayCents ?? 0 }
      : row.costShareType === "coinsurance"
        ? { type: "coinsurance", rate: row.coinsuranceRate ?? 0 }
        : { type: "full_coverage" };

  const limit: CoverageLimit =
    row.limitUnit === "dollars"
      ? { unit: "dollars", amountCents: row.limitAmountCents ?? 0 }
      : row.limitUnit === "visits"
        ? { unit: "visits", count: row.limitCount ?? 0 }
        : { unit: "none" };

  return {
    policyId: row.policyId,
    serviceCode: row.serviceCode,
    covered: row.covered,
    excluded: row.excluded,
    costShare,
    appliesDeductible: row.appliesDeductible,
    limit,
    requiresPriorAuth: row.requiresPriorAuth,
  };
}

export function createCoverageRuleRepository(db: Db) {
  return {
    db,
    findByPolicy(policyId: string): CoverageRule[] {
      return db
        .select()
        .from(coverageRules)
        .where(eq(coverageRules.policyId, policyId))
        .all()
        .map(rowToCoverageRule);
    },
  };
}

export type CoverageRuleRepository = ReturnType<
  typeof createCoverageRuleRepository
>;
