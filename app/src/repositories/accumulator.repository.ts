// app/src/repositories/accumulator.repository.ts — accumulator read-snapshot + atomic writeback.
//
// Skeleton (chore): snapshot (read all dimensions for member+plan_year) and upsert (UPDATE-in-place
// per dimension) arrive test-first with cycles 26 / 35. accumulators is the one UPDATE-in-place
// table; per-dimension rows are keyed by (member_id, plan_year, dimension).

import type { Db } from "../db/connection";

export function createAccumulatorRepository(db: Db) {
  return { db };
}

export type AccumulatorRepository = ReturnType<
  typeof createAccumulatorRepository
>;
