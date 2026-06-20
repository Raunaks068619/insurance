import { describe, expect, it } from "vitest";
import type { RawDb } from "../src/db/connection";
import { freshDb, makeClaimService, seedWorld } from "./db-helpers";

// Cycle 7 (service wiring) — the pure adjudicator already denies a duplicate when told
// `alreadyAdjudicated: true`; this proves the SERVICE now computes that flag from the DB.
// A line is a duplicate when ANOTHER already-adjudicated line shares its fingerprint
// (memberId|serviceCode|serviceDate|billedCents) — across claims or within one claim.

describe("adjudicateClaim — duplicate line detection (cycle 7)", () => {
  const seeded = () => {
    const handle = freshDb();
    const { memberId } = seedWorld(handle.db, {
      rules: [
        { serviceCode: "PREVENTIVE", costShare: { type: "full_coverage" } },
      ],
    });
    return { handle, service: makeClaimService(handle), memberId };
  };

  // The (status, reasons) of every adjudicated line under one claim.
  const decisionsFor = (sqlite: RawDb, claimId: string) =>
    (
      sqlite
        .prepare(
          `SELECT a.status AS status, a.reasons_json AS reasons
             FROM adjudications a
             JOIN line_items li ON li.id = a.line_item_id
            WHERE li.claim_id = ?`,
        )
        .all(claimId) as { status: string; reasons: string }[]
    ).map((r) => ({
      status: r.status,
      reasons: JSON.parse(r.reasons) as string[],
    }));

  it("denies an identical line submitted in a second claim", () => {
    const { handle, service, memberId } = seeded();
    const line = { serviceCode: "PREVENTIVE", billedCents: 12_000 };

    const first = service.adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [line],
    });
    const second = service.adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [line],
    });

    expect(first.status).toBe("APPROVED"); // the original is paid
    expect(second.status).toBe("DENIED"); // the resubmission is denied

    const decisions = decisionsFor(handle.sqlite, second.claimId);
    expect(decisions).toEqual([
      { status: "DENIED", reasons: ["DUPLICATE_LINE_ITEM"] },
    ]);
  });

  it("approves the first occurrence and denies the duplicate within one claim", () => {
    const { handle, service, memberId } = seeded();
    const line = { serviceCode: "PREVENTIVE", billedCents: 12_000 };

    const result = service.adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [line, line], // same fingerprint twice
    });

    expect(result.status).toBe("PARTIALLY_APPROVED"); // one paid + one denied

    const decisions = decisionsFor(handle.sqlite, result.claimId);
    expect(decisions).toHaveLength(2);
    expect(decisions.filter((d) => d.status === "APPROVED")).toHaveLength(1);
    expect(decisions.filter((d) => d.status === "DENIED")).toEqual([
      { status: "DENIED", reasons: ["DUPLICATE_LINE_ITEM"] },
    ]);
  });

  it("does not flag distinct lines (different billed amount) as duplicates", () => {
    const { handle, service, memberId } = seeded();

    const result = service.adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [
        { serviceCode: "PREVENTIVE", billedCents: 12_000 },
        { serviceCode: "PREVENTIVE", billedCents: 9_900 }, // different fingerprint
      ],
    });

    expect(result.status).toBe("APPROVED");
    const decisions = decisionsFor(handle.sqlite, result.claimId);
    expect(decisions.every((d) => d.status === "APPROVED")).toBe(true);
  });
});
