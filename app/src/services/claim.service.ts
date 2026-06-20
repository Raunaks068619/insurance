// app/src/services/claim.service.ts — orchestration: submit claim -> adjudicate -> persist.
//
// A SERVICE holds business logic / workflows; it depends on REPOSITORIES (which own the Db and
// encapsulate all data access), never on the raw connection. Layering: service → repositories → db.
//
// Skeleton (chore): the orchestration (snapshot accumulators once → adjudicate each line in stable
// order applying deltas between lines → aggregate the claim status → persist) lands test-first at
// the writeback cycles (26+). The ONE-transaction-per-claim boundary is wired then too — passed in
// as a `withTransaction` runner so the raw Db still never leaks into the service.

import type { AccumulatorRepository } from "../repositories/accumulator.repository";
import type { AdjudicationRepository } from "../repositories/adjudication.repository";
import type { ClaimRepository } from "../repositories/claim.repository";

export type ClaimServiceDeps = {
  claims: ClaimRepository;
  adjudications: AdjudicationRepository;
  accumulators: AccumulatorRepository;
};

export function createClaimService(deps: ClaimServiceDeps) {
  // methods (submitClaim, adjudicateClaim …) land test-first; deps are repositories, not the Db.
  return deps;
}

export type ClaimService = ReturnType<typeof createClaimService>;
