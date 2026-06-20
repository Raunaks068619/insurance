import { describe, expect, it } from "vitest";
import { freshDb, makeApp, seedWorld } from "./db-helpers";

// GET /claims/:id fetches a persisted claim's snapshot: its derived status, each line item's
// current decision, the claim-level payable sum, and the status-transition timeline. An unknown
// id is a 404 (a missing resource), not a server error.

describe("GET /claims/:id — fetch a claim snapshot", () => {
  // A mixed seed: PREVENTIVE (full coverage → APPROVED) + ADULT_DENTAL (excluded → DENIED).
  const appWithSeed = () => {
    const handle = freshDb();
    const { memberId } = seedWorld(handle.db, {
      rules: [
        { serviceCode: "PREVENTIVE", costShare: { type: "full_coverage" } },
        { serviceCode: "ADULT_DENTAL", excluded: true },
      ],
    });
    return { app: makeApp(handle), memberId };
  };

  const submitClaim = (app: ReturnType<typeof makeApp>, memberId: string) =>
    app.inject({
      method: "POST",
      url: "/claims",
      payload: {
        memberId,
        serviceDate: "2026-06-19",
        lineItems: [
          { serviceCode: "PREVENTIVE", billedCents: 12_000 },
          { serviceCode: "ADULT_DENTAL", billedCents: 8_000 },
        ],
      },
    });

  it("returns the claim snapshot with status, line decisions, payable sum, and timeline", async () => {
    const { app, memberId } = appWithSeed();
    const claimId = (await submitClaim(app, memberId)).json().id;

    const res = await app.inject({ method: "GET", url: `/claims/${claimId}` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(claimId);
    expect(body.status).toBe("PARTIALLY_APPROVED");
    expect(body.totalPayableCents).toBe(12_000);
    expect(body.lineItems).toHaveLength(2);

    // the timeline opens with the claim SUBMIT and closes with its aggregated status
    expect(body.timeline[0].toStatus).toBe("SUBMITTED");
    expect(body.timeline.at(-1).toStatus).toBe("PARTIALLY_APPROVED");
  });

  it("returns 404 with a not-found code for an unknown claim id", async () => {
    const { app } = appWithSeed();

    const res = await app.inject({
      method: "GET",
      url: "/claims/does-not-exist",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("CLAIM_NOT_FOUND");
  });
});
