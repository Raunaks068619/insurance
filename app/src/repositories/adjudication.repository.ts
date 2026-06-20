// app/src/repositories/adjudication.repository.ts — append-only adjudication persistence.
//
// Skeleton (chore): insert (append a new decision) + history/current-by-MAX(seq) reads arrive
// test-first with cycles 26–27 / 32–36. Append-only is enforced by triggers in schema.sql;
// this repo must only ever INSERT (never UPDATE/DELETE/REPLACE) on adjudications.

import type { Db } from "../db/connection";

export function createAdjudicationRepository(db: Db) {
  return { db };
}

export type AdjudicationRepository = ReturnType<
  typeof createAdjudicationRepository
>;
