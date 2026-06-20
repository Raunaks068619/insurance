// app/src/repositories/claim.repository.ts — claims + line-items persistence (Drizzle typed queries).
//
// Skeleton (chore): query methods (insert a claim + its lines, load the claim aggregate, setStatus)
// arrive test-first with the writeback cycles (26–31). The repo takes the Db handle by injection so
// a test can pass a fresh in-memory connection from createDb(':memory:').

import type { Db } from "../db/connection";

export function createClaimRepository(db: Db) {
  // methods land test-first; the Db seam is wired now so callers/tests can inject it.
  return { db };
}

export type ClaimRepository = ReturnType<typeof createClaimRepository>;
