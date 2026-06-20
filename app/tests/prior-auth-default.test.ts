import { describe, expect, it } from "vitest";
import type { RawDb } from "../src/db/connection";
import { freshDb, makeClaimService, seedWorld } from "./db-helpers";

// Cycle 6 (service wiring) — prior auth is a FAIL-CLOSED control. The pure adjudicator already
// denies when `requiresPriorAuth && !priorAuthPresent`; these prove the SERVICE/REPOSITORY default
// for an OMITTED `priorAuthPresent` is `false` (absence = NOT obtained), not `true`. A line on a
// prior-auth service that does not assert auth must DENY `PRIOR_AUTH_REQUIRED` — never silently pay.
// (Reverses the original "absence = present" default; see decisions.md.)

describe("adjudicateClaim — prior-auth defaulting (fail-closed)", () => {
  const seeded = () => {
    const handle = freshDb();
    const { memberId } = seedWorld(handle.db, {
      rules: [
        {
          serviceCode: "MRI",
          costShare: { type: "coinsurance", rate: 0.2 },
          appliesDeductible: true,
          requiresPriorAuth: true,
        },
      ],
    });
    return { handle, service: makeClaimService(handle), memberId };
  };

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

  it("DENIES a prior-auth service when priorAuthPresent is OMITTED (absence = not obtained)", () => {
    const { handle, service, memberId } = seeded();

    const result = service.adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [{ serviceCode: "MRI", billedCents: 120_000 }], // no priorAuthPresent
    });

    expect(result.status).toBe("DENIED");
    expect(decisionsFor(handle.sqlite, result.claimId)).toEqual([
      { status: "DENIED", reasons: ["PRIOR_AUTH_REQUIRED"] },
    ]);
  });

  it("DENIES when priorAuthPresent is explicitly false", () => {
    const { handle, service, memberId } = seeded();

    const result = service.adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [
        { serviceCode: "MRI", billedCents: 120_000, priorAuthPresent: false },
      ],
    });

    expect(result.status).toBe("DENIED");
    expect(decisionsFor(handle.sqlite, result.claimId)).toEqual([
      { status: "DENIED", reasons: ["PRIOR_AUTH_REQUIRED"] },
    ]);
  });

  it("APPROVES when priorAuthPresent is explicitly true (auth obtained)", () => {
    const { service, memberId } = seeded();

    const result = service.adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [
        { serviceCode: "MRI", billedCents: 120_000, priorAuthPresent: true },
      ],
    });

    expect(result.status).toBe("APPROVED");
  });
});
