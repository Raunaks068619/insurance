import { describe, expect, it } from "vitest";
import { freshDb, makeApp, seedWorld } from "./db-helpers";

// GET /claims/:id/explanation is the EOB in miniature: per line item, the reason code(s), the
// human-readable explanation sentence, and the numbers used (billed / payable / member owed). It
// reads each line's CURRENT decision; an unknown claim is a 404.

describe("GET /claims/:id/explanation — per-line explanation", () => {
  // PREVENTIVE (full coverage → APPROVED, plan pays 100%) + ADULT_DENTAL (excluded → DENIED).
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

  const submit = (app: ReturnType<typeof makeApp>, memberId: string) =>
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

  it("returns each line's reason code, explanation text, and the numbers used", async () => {
    const { app, memberId } = appWithSeed();
    const claimId = (await submit(app, memberId)).json().id;

    const res = await app.inject({
      method: "GET",
      url: `/claims/${claimId}/explanation`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.claimId).toBe(claimId);
    expect(body.lineItems).toHaveLength(2);

    const preventive = body.lineItems.find(
      (l: { serviceCode: string }) => l.serviceCode === "PREVENTIVE",
    );
    expect(preventive.reasons).toContain("APPROVED");
    expect(preventive.explanation).toMatch(/plan pays 100%/i); // the EOB sentence
    expect(preventive.payableCents).toBe(12_000);
    expect(preventive.memberResponsibilityCents).toBe(0);

    const dental = body.lineItems.find(
      (l: { serviceCode: string }) => l.serviceCode === "ADULT_DENTAL",
    );
    expect(dental.reasons).toContain("EXCLUDED");
    expect(dental.payableCents).toBe(0);
    expect(typeof dental.explanation).toBe("string");
    expect(dental.explanation.length).toBeGreaterThan(0);
  });

  it("returns 404 for an unknown claim id", async () => {
    const { app } = appWithSeed();

    const res = await app.inject({
      method: "GET",
      url: "/claims/does-not-exist/explanation",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("CLAIM_NOT_FOUND");
  });
});
