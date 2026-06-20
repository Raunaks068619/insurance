import { describe, expect, it } from "vitest";
import type { DbHandle } from "../src/db/connection";
import { ReasonCode } from "../src/domain/reason-codes";
import { createAdjudicationRepository } from "../src/repositories/adjudication.repository";
import { createClaimRepository } from "../src/repositories/claim.repository";
import { createStatusTransitionRepository } from "../src/repositories/status-transition.repository";
import { createClaimReadService } from "../src/services/claim-read.service";
import { freshDb, makeClaimService, seedWorld } from "./db-helpers";

// GET /claims/:id and POST /claims both need ONE read-model assembler: the claim's derived
// status + each line item's CURRENT decision (the EOB payload) + the claim-level payable sum +
// the lifecycle timeline. This pins that assembler at the service+db level, before any HTTP wiring.

function readServiceFor(handle: DbHandle) {
  const { db } = handle;
  return createClaimReadService({
    claims: createClaimRepository(db),
    adjudications: createAdjudicationRepository(db),
    statusTransitions: createStatusTransitionRepository(db),
  });
}

describe("claimReadService.getClaimById — claim snapshot for GET /claims/:id", () => {
  // A mixed claim: PREVENTIVE (full coverage → APPROVED) + ADULT_DENTAL (excluded → DENIED).
  const seedAndAdjudicateMixedClaim = () => {
    const handle = freshDb();
    const { memberId } = seedWorld(handle.db, {
      rules: [
        { serviceCode: "PREVENTIVE", costShare: { type: "full_coverage" } },
        { serviceCode: "ADULT_DENTAL", excluded: true },
      ],
    });
    const { claimId } = makeClaimService(handle).adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [
        { serviceCode: "PREVENTIVE", billedCents: 12_000 },
        { serviceCode: "ADULT_DENTAL", billedCents: 8_000 },
      ],
    });
    return { handle, claimId };
  };

  it("returns the claim status, each line's current decision, and the total payable sum", () => {
    const { handle, claimId } = seedAndAdjudicateMixedClaim();

    const snapshot = readServiceFor(handle).getClaimById(claimId);

    expect(snapshot?.status).toBe("PARTIALLY_APPROVED"); // one approved + one denied
    expect(snapshot?.lineItems).toHaveLength(2);

    const preventive = snapshot?.lineItems.find(
      (l) => l.serviceCode === "PREVENTIVE",
    );
    expect(preventive?.status).toBe("APPROVED");
    expect(preventive?.payableCents).toBe(12_000);
    expect(preventive?.reasons).toContain(ReasonCode.APPROVED);

    const dental = snapshot?.lineItems.find(
      (l) => l.serviceCode === "ADULT_DENTAL",
    );
    expect(dental?.status).toBe("DENIED");
    expect(dental?.payableCents).toBe(0);
    expect(dental?.reasons).toContain(ReasonCode.EXCLUDED);

    expect(snapshot?.totalPayableCents).toBe(12_000); // only the approved line pays
  });

  it("includes the lifecycle timeline ordered by seq, opening with the claim SUBMIT", () => {
    const { handle, claimId } = seedAndAdjudicateMixedClaim();

    const timeline =
      readServiceFor(handle).getClaimById(claimId)?.timeline ?? [];

    expect(timeline.length).toBeGreaterThan(0);
    const seqs = timeline.map((t) => t.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // monotonic by seq

    const first = timeline[0];
    expect(first?.entityType).toBe("CLAIM");
    expect(first?.fromStatus).toBeNull();
    expect(first?.toStatus).toBe("SUBMITTED");

    // the claim's final transition is the AGGREGATED roll-up to its derived status
    const claimTransitions = timeline.filter((t) => t.entityType === "CLAIM");
    expect(claimTransitions.at(-1)?.reason).toBe("AGGREGATED");
    expect(claimTransitions.at(-1)?.toStatus).toBe("PARTIALLY_APPROVED");
  });

  it("returns undefined for an unknown claim id", () => {
    const handle = freshDb();
    expect(readServiceFor(handle).getClaimById("nope")).toBeUndefined();
  });
});
