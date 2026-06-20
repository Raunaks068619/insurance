// app/src/services/set-status.ts — the ONE status-change chokepoint (decision #15/#20).
//
// setStatus() updates the entity's status column AND appends a status-transition row in the SAME
// write, so the log can never drift from the columns. `seq` is a per-claim logical clock
// (claims.claim_seq is its head), giving the merged GET /claims/:id timeline a deterministic total
// order. Both the claim and dispute services route every status change through here.

import type { ClaimStatus } from "../domain/entities/claim";
import type { LineItemStatus } from "../domain/entities/line-item";
import type { ClaimRepository } from "../repositories/claim.repository";
import type {
  StatusTransitionRepository,
  TransitionActor,
  TransitionReason,
} from "../repositories/status-transition.repository";

export type SetStatusArgs = {
  claimId: string; // the owning claim aggregate (the clock's key)
  target:
    | { type: "CLAIM"; status: ClaimStatus }
    | { type: "LINE_ITEM"; id: string; status: LineItemStatus };
  fromStatus: string | null;
  actor: TransitionActor;
  reason: TransitionReason;
};

export type SetStatus = (args: SetStatusArgs) => void;

export function createSetStatus(deps: {
  claims: ClaimRepository;
  statusTransitions: StatusTransitionRepository;
}): SetStatus {
  return (args) => {
    const seq = deps.claims.bumpClaimSeq(args.claimId);
    deps.statusTransitions.append({
      entityType: args.target.type,
      claimId: args.claimId,
      lineItemId: args.target.type === "LINE_ITEM" ? args.target.id : null,
      fromStatus: args.fromStatus,
      toStatus: args.target.status,
      actor: args.actor,
      reason: args.reason,
      seq,
    });
    if (args.target.type === "CLAIM") {
      deps.claims.setClaimStatus(args.claimId, args.target.status);
    } else {
      deps.claims.setLineStatus(args.target.id, args.target.status);
    }
  };
}
