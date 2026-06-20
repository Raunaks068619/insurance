import { describe, expect, it } from "vitest";
import { ReasonCode } from "../src/domain/reason-codes";
import { createAdjudicationRepository } from "../src/repositories/adjudication.repository";
import { freshDb, makeClaimService, seedWorld } from "./db-helpers";

// The B4 explanation endpoint reads each line's CURRENT decision back out of the store:
// reason codes, the EOB explanation text, and the numbers (payable + member responsibility).
// The write path already persists all of these (cycle 26); these tests pin the READ path —
// in particular that `explanation` survives the round-trip (it was being dropped on read).

describe("AdjudicationRepository — claim explanation read path (B4)", () => {
  // One full_coverage line, adjudicated through the real SQLite store.
  const adjudicateOneFullCoverageLine = () => {
    const handle = freshDb();
    const { memberId } = seedWorld(handle.db, {
      rules: [
        { serviceCode: "PREVENTIVE", costShare: { type: "full_coverage" } },
      ],
    });
    const { claimId } = makeClaimService(handle).adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [{ serviceCode: "PREVENTIVE", billedCents: 12_000 }],
    });
    return { db: handle.db, claimId };
  };

  it("returns each line's current decision with reasons, explanation, and the numbers", () => {
    const { db, claimId } = adjudicateOneFullCoverageLine();

    const lines = createAdjudicationRepository(db).byClaimId(claimId);

    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line?.serviceCode).toBe("PREVENTIVE");
    expect(line?.billedCents).toBe(12_000);
    expect(line?.status).toBe("APPROVED");
    expect(line?.payableCents).toBe(12_000);
    expect(line?.memberResponsibilityCents).toBe(0);
    expect(line?.reasons).toContain(ReasonCode.APPROVED);
    expect(line?.explanation).toMatch(/plan pays 100%/i); // EOB text survives the read
  });

  it("carries the explanation on a line's current decision too (currentForLine)", () => {
    const { db, claimId } = adjudicateOneFullCoverageLine();
    const repo = createAdjudicationRepository(db);

    const lineItemId = repo.byClaimId(claimId)[0]?.lineItemId ?? "";
    const current = repo.currentForLine(lineItemId);

    expect(current?.explanation).toMatch(/plan pays 100%/i);
  });
});
