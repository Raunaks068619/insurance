// app/src/repositories/accumulator.repository.ts — accumulator read-snapshot + atomic writeback.
// The one UPDATE-in-place table; per-dimension rows keyed by (member_id, plan_year, dimension).

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/connection";
import { accumulators } from "../db/schema";

const LIMIT_PREFIX = "LIMIT:";

export type AccumulatorState = {
  deductibleMetCents: number;
  oopMetCents: number;
  limitUsedByService: Record<string, number>;
};

export function createAccumulatorRepository(db: Db) {
  return {
    db,

    // Read every dimension for a member+plan_year into one working snapshot.
    snapshot(memberId: string, planYear: string): AccumulatorState {
      const rows = db
        .select()
        .from(accumulators)
        .where(
          and(
            eq(accumulators.memberId, memberId),
            eq(accumulators.planYear, planYear),
          ),
        )
        .all();
      const state: AccumulatorState = {
        deductibleMetCents: 0,
        oopMetCents: 0,
        limitUsedByService: {},
      };
      for (const row of rows) {
        if (row.dimension === "DEDUCTIBLE")
          state.deductibleMetCents = row.usedCents;
        else if (row.dimension === "OOP") state.oopMetCents = row.usedCents;
        else if (row.dimension.startsWith(LIMIT_PREFIX)) {
          const service = row.dimension.slice(LIMIT_PREFIX.length);
          state.limitUsedByService[service] =
            row.unit === "COUNT" ? row.usedCount : row.usedCents;
        }
      }
      return state;
    },

    // Insert-or-update one dimension's running total (UNIQUE member+year+dimension).
    upsert(args: {
      memberId: string;
      planYear: string;
      dimension: string;
      unit: "CENTS" | "COUNT";
      usedCents: number;
      usedCount: number;
    }): void {
      db.insert(accumulators)
        .values({
          id: randomUUID(),
          memberId: args.memberId,
          planYear: args.planYear,
          dimension: args.dimension,
          unit: args.unit,
          usedCents: args.usedCents,
          usedCount: args.usedCount,
        })
        .onConflictDoUpdate({
          target: [
            accumulators.memberId,
            accumulators.planYear,
            accumulators.dimension,
          ],
          set: { usedCents: args.usedCents, usedCount: args.usedCount },
        })
        .run();
    },
  };
}

export type AccumulatorRepository = ReturnType<
  typeof createAccumulatorRepository
>;
