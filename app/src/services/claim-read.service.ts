// app/src/services/claim-read.service.ts — read-model assembler (the query side).
//
// Both GET /claims/:id and the POST /claims response need ONE snapshot of a claim: its derived
// status, each line item's CURRENT decision (the EOB payload), the claim-level payable sum, and
// the lifecycle timeline. This service composes the read repositories only — no writes, no
// re-adjudication. Layering: service → repositories → db.

import type { ClaimStatus } from "../domain/entities/claim";
import type {
  AdjudicationRepository,
  ClaimAdjudicationLine,
} from "../repositories/adjudication.repository";
import type { ClaimRepository } from "../repositories/claim.repository";
import type {
  StatusTransitionRepository,
  TransitionRecord,
} from "../repositories/status-transition.repository";

export type ClaimSnapshot = {
  id: string;
  memberId: string;
  serviceDate: string;
  status: ClaimStatus;
  totalPayableCents: number; // Σ of every line's current payable
  lineItems: ClaimAdjudicationLine[];
  timeline: TransitionRecord[];
};

export type ClaimReadServiceDeps = {
  claims: ClaimRepository;
  adjudications: AdjudicationRepository;
  statusTransitions: StatusTransitionRepository;
};

export function createClaimReadService(deps: ClaimReadServiceDeps) {
  function getClaimById(id: string): ClaimSnapshot | undefined {
    const claim = deps.claims.findClaimById(id);
    if (!claim) return undefined;

    const lineItems = deps.adjudications.byClaimId(id);
    const totalPayableCents = lineItems.reduce(
      (sum, line) => sum + line.payableCents,
      0,
    );
    const timeline = deps.statusTransitions.byClaimId(id);

    return {
      id: claim.id,
      memberId: claim.memberId,
      serviceDate: claim.serviceDate,
      status: claim.status,
      totalPayableCents,
      lineItems,
      timeline,
    };
  }

  return { ...deps, getClaimById };
}

export type ClaimReadService = ReturnType<typeof createClaimReadService>;
