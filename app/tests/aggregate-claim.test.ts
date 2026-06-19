import { describe, expect, it } from "vitest";
import { aggregateClaimStatus } from "../src/domain/state-machines/claim-state";

// Claim status is DERIVED from its line items, never set directly. This suite drives the
// roll-up rules (cycles 22–25): all-approved, all-denied, mixed, and straddle-partial.

describe("aggregateClaimStatus — line items roll up to a claim status", () => {
  it("aggregates to APPROVED when every line item is approved", () => {
    // Arrange — the load-bearing fact: every line is a clean APPROVED (full payable, no straddle).
    const lines = aggregateClaimStatus([
      { status: "APPROVED", reasons: ["APPROVED"] },
      { status: "APPROVED", reasons: ["APPROVED"] },
    ]);

    // Assert — a claim with nothing denied and no partial is fully APPROVED.
    expect(lines).toBe("APPROVED");
  });

  it("aggregates to DENIED when every line item is denied", () => {
    // Arrange — the load-bearing fact: every line is a gate denial, nothing payable.
    const status = aggregateClaimStatus([
      { status: "DENIED", reasons: ["NO_COVERAGE"] },
      { status: "DENIED", reasons: ["EXCLUDED"] },
    ]);

    // Assert — a claim with no approved line is DENIED.
    expect(status).toBe("DENIED");
  });

  it("aggregates to PARTIALLY_APPROVED when some lines approve and some deny", () => {
    // Arrange — the load-bearing fact: a mix of one approved and one denied line.
    const status = aggregateClaimStatus([
      { status: "APPROVED", reasons: ["APPROVED"] },
      { status: "DENIED", reasons: ["NO_COVERAGE"] },
    ]);

    // Assert — partial payout: the claim is neither fully approved nor fully denied.
    expect(status).toBe("PARTIALLY_APPROVED");
  });

  it("aggregates to PARTIALLY_APPROVED when an approved line straddles its dollar limit", () => {
    // Arrange — the load-bearing fact: no line is DENIED, but one APPROVED line straddled its
    // dollar cap (plan capped at the remaining limit, shortfall to the member) → carries
    // LIMIT_EXCEEDED. A partial-payout line makes the whole claim partial.
    const status = aggregateClaimStatus([
      { status: "APPROVED", reasons: ["APPROVED"] },
      { status: "APPROVED", reasons: ["APPROVED", "LIMIT_EXCEEDED"] },
    ]);

    // Assert — a straddle is NOT a denial, but it is also not a full approval.
    expect(status).toBe("PARTIALLY_APPROVED");
  });
});
