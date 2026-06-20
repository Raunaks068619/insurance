// app/src/repositories/policy.repository.ts — policy reads (resolve a member's active policy).

import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "../db/connection";
import { policies } from "../db/schema";
import type { Policy } from "../domain/types";

const toPolicy = (row: typeof policies.$inferSelect): Policy => ({
  id: row.id,
  memberId: row.memberId,
  planYear: Number(row.planYear),
  effectiveDate: row.effectiveDate,
  terminationDate: row.terminationDate,
  deductibleCents: row.deductibleCents,
  oopMaxCents: row.oopMaxCents,
});

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
      return row ? toPolicy(row) : undefined;
    },

    // The member's policy regardless of the service date (v1: one policy per member; seed has one).
    // Returned even when the date is out of window so the adjudicator's POLICY_NOT_ACTIVE gate can
    // fire — only a member with NO policy at all is unresolvable (an intake reject upstream).
    findByMember(memberId: string): Policy | undefined {
      const row = db
        .select()
        .from(policies)
        .where(eq(policies.memberId, memberId))
        .orderBy(desc(policies.effectiveDate))
        .get();
      return row ? toPolicy(row) : undefined;
    },
  };
}

export type PolicyRepository = ReturnType<typeof createPolicyRepository>;
