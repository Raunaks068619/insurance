import { describe, expect, it } from "vitest";
import type { ClaimService } from "../src/services/claim.service";
import { freshDb, makeApp, seedWorld } from "./db-helpers";

// An UNEXPECTED throw (anything that isn't a validation failure or an intentional 4xx) must fail
// closed as a generic 500 — never leaking the underlying error's message/code (which can carry DB
// internals like table/column names). Validation 400s and intentional 4xx detail are unaffected.

describe("central error handler — unexpected errors do not leak internals", () => {
  const SECRET = "secret: SQLITE table line_items column billed_cents";

  it("maps an unexpected service throw to a generic 500 with no internal detail", async () => {
    const handle = freshDb();
    const { memberId } = seedWorld(handle.db, {
      rules: [
        { serviceCode: "PREVENTIVE", costShare: { type: "full_coverage" } },
      ],
    });

    // A claimService whose adjudicateClaim throws a non-intake error with a sensitive message.
    const throwingClaimService = {
      adjudicateClaim: () => {
        throw new Error(SECRET);
      },
    } as unknown as ClaimService;

    const app = makeApp(handle, { claimService: throwingClaimService });

    const res = await app.inject({
      method: "POST",
      url: "/claims",
      payload: {
        memberId,
        serviceDate: "2026-06-19",
        lineItems: [{ serviceCode: "PREVENTIVE", billedCents: 12_000 }],
      },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    expect(res.payload).not.toContain(SECRET); // the underlying message never reaches the client
  });
});
