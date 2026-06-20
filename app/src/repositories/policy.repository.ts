// app/src/repositories/policy.repository.ts — policy reads (resolve a member's active policy).

import { and, eq, gte, lte } from "drizzle-orm";
import type { Db } from "../db/connection";
import { policies } from "../db/schema";
import type { Policy } from "../domain/types";

export function createPolicyRepository(db: Db) {
  return {
    db,
    // The active policy for a member on a service date: effective ≤ date ≤ termination.
    findActiveForMember(
      memberId: string,
      serviceDate: string,
    ): Policy | undefined {
      const row = db
        .select()
        .from(policies)
        .where(
          and(
            eq(policies.memberId, memberId),
            lte(policies.effectiveDate, serviceDate),
            gte(policies.terminationDate, serviceDate),
          ),
        )
        .get();
      if (!row) return undefined;
      return {
        id: row.id,
        memberId: row.memberId,
        planYear: Number(row.planYear),
        effectiveDate: row.effectiveDate,
        terminationDate: row.terminationDate,
        deductibleCents: row.deductibleCents,
        oopMaxCents: row.oopMaxCents,
      };
    },
  };
}

export type PolicyRepository = ReturnType<typeof createPolicyRepository>;
