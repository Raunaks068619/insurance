import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import {
  freshDb,
  makeClaimReadService,
  makeClaimService,
  seedWorld,
} from "./db-helpers";

// POST /claims is the submit + adjudicate entrypoint. A structurally valid claim is accepted,
// adjudicated synchronously, and the 201 response carries the claim's derived status, each line's
// CURRENT decision (status / payable / reason codes), and the claim-level payable sum.

describe("POST /claims — submit and adjudicate", () => {
  // A mixed seed: PREVENTIVE (full coverage → APPROVED) + ADULT_DENTAL (excluded → DENIED).
  const appWithSeed = () => {
    const handle = freshDb();
    const { memberId } = seedWorld(handle.db, {
      rules: [
        { serviceCode: "PREVENTIVE", costShare: { type: "full_coverage" } },
        { serviceCode: "ADULT_DENTAL", excluded: true },
      ],
    });
    const app = buildApp({
      claimService: makeClaimService(handle),
      claimReadService: makeClaimReadService(handle),
    });
    return { app, memberId };
  };

  it("accepts a valid claim, adjudicates each line, and returns the per-line decisions", async () => {
    const { app, memberId } = appWithSeed();

    const res = await app.inject({
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

    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.status).toBe("PARTIALLY_APPROVED"); // one approved + one denied
    expect(body.totalPayableCents).toBe(12_000); // only the approved line pays

    const lines: Array<{
      serviceCode: string;
      status: string;
      payableCents: number;
      reasons: string[];
    }> = body.lineItems;

    const preventive = lines.find((l) => l.serviceCode === "PREVENTIVE");
    expect(preventive?.status).toBe("APPROVED");
    expect(preventive?.payableCents).toBe(12_000);
    expect(preventive?.reasons).toContain("APPROVED");

    const dental = lines.find((l) => l.serviceCode === "ADULT_DENTAL");
    expect(dental?.status).toBe("DENIED");
    expect(dental?.payableCents).toBe(0);
    expect(dental?.reasons).toContain("EXCLUDED");
  });
});
