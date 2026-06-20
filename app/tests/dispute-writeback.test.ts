import { describe, expect, it } from "vitest";
import {
  freshDb,
  makeClaimService,
  makeDisputeService,
  seedWorld,
} from "./db-helpers";

// Cycle 27 — a dispute reopens a terminal line, re-adjudicates against current rules + corrected
// facts, and PRESERVES THE ORIGINAL decision immutably: a NEW adjudication is appended at a higher
// seq; the original row is never mutated. (Outcome taxonomy → 32–36; net-out → 35; transitions → 31.)

describe("disputeService.open — re-adjudication preserves the original (cycle 27)", () => {
  // MRI needs prior auth; submitted without it → DENIED. Dispute with corrected prior_auth → APPROVED.
  const disputeMri = () => {
    const { db, sqlite } = freshDb();
    const { memberId } = seedWorld(db, {
      rules: [
        {
          serviceCode: "MRI",
          costShare: { type: "coinsurance", rate: 0.2 },
          appliesDeductible: true,
          requiresPriorAuth: true,
        },
      ],
    });
    makeClaimService({ db, sqlite }).adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [
        { serviceCode: "MRI", billedCents: 90_000, priorAuthPresent: false },
      ],
    });
    const lineItemId = (
      sqlite.prepare("SELECT id FROM line_items").get() as { id: string }
    ).id;

    const result = makeDisputeService({ db, sqlite }).open({
      lineItemId,
      reason: "prior auth was on file at the time of service",
      corrected: { priorAuthPresent: true },
    });
    return { sqlite, lineItemId, result };
  };

  it("appends a new adjudication and never mutates the original", () => {
    const { sqlite, lineItemId } = disputeMri();
    const adjs = sqlite
      .prepare(
        "SELECT seq, status, payable_cents FROM adjudications WHERE line_item_id = ? ORDER BY seq",
      )
      .all(lineItemId) as {
      seq: number;
      status: string;
      payable_cents: number;
    }[];

    expect(adjs).toHaveLength(2);
    // original decision preserved exactly — DENIED, paid nothing
    expect(adjs[0]).toMatchObject({
      seq: 1,
      status: "DENIED",
      payable_cents: 0,
    });
    // the dispute appended a NEW decision at a higher seq
    expect(adjs[1]?.seq).toBe(2);
    expect(adjs[1]?.status).toBe("APPROVED");
  });

  it("records a RESOLVED dispute linking the original and resolved adjudications", () => {
    const { sqlite, result } = disputeMri();
    const dispute = sqlite.prepare("SELECT * FROM disputes").get() as {
      state: string;
      outcome: string;
      original_adjudication_id: string;
      resolved_adjudication_id: string;
    };

    expect(dispute.state).toBe("RESOLVED");
    expect(dispute.outcome).toBe("OVERTURNED"); // DENIED → APPROVED, no residual limit
    expect(dispute.original_adjudication_id).not.toBe(
      dispute.resolved_adjudication_id,
    );
    expect(result.outcome).toBe("OVERTURNED");
  });

  it("rejects any direct mutation of the original adjudication (append-only)", () => {
    const { sqlite } = disputeMri();
    expect(() =>
      sqlite.exec("UPDATE adjudications SET status = 'APPROVED' WHERE seq = 1"),
    ).toThrow(/append-only/);
  });
});
