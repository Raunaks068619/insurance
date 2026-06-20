import { describe, expect, it } from "vitest";
import { freshDb, makeApp, seedWorld } from "./db-helpers";

// Member/policy resolution at intake. The engine already treats an out-of-window service date as a
// POLICY_NOT_ACTIVE *decision* (adjudicate-line.test.ts) — the service must hand it the policy so
// that gate fires, instead of pre-filtering by date and throwing. Two distinct outcomes:
//   - member HAS a policy, but the service date is outside its window -> POLICY_NOT_ACTIVE (201 decision)
//   - member has NO policy on file -> intake reject (400), nothing persisted

describe("POST /claims — member/policy resolution", () => {
  const appWithSeed = () => {
    const handle = freshDb();
    const { memberId } = seedWorld(handle.db, {
      rules: [
        { serviceCode: "PREVENTIVE", costShare: { type: "full_coverage" } },
      ],
    });
    return { handle, app: makeApp(handle), memberId };
  };

  it("adjudicates an out-of-window claim as a POLICY_NOT_ACTIVE decision (201), not a 500", async () => {
    const { app, memberId } = appWithSeed();

    // The seeded policy is active 2026-01-01..2026-12-31; this date precedes it (and is not future).
    const res = await app.inject({
      method: "POST",
      url: "/claims",
      payload: {
        memberId,
        serviceDate: "2025-06-19",
        lineItems: [{ serviceCode: "PREVENTIVE", billedCents: 12_000 }],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("DENIED");

    const line = body.lineItems[0];
    expect(line.status).toBe("DENIED");
    expect(line.payableCents).toBe(0);
    expect(line.reasons).toContain("POLICY_NOT_ACTIVE");
  });

  it("rejects a claim for a member with no policy on file as 400, persisting nothing", async () => {
    const { handle, app } = appWithSeed();

    const res = await app.inject({
      method: "POST",
      url: "/claims",
      payload: {
        memberId: "ghost-member",
        serviceDate: "2026-06-19",
        lineItems: [{ serviceCode: "PREVENTIVE", billedCents: 12_000 }],
      },
    });

    expect(res.statusCode).toBe(400);
    const errors = res.json().errors as Array<{ field: string; code: string }>;
    expect(errors[0]?.field).toBe("memberId");

    const { c } = handle.sqlite
      .prepare("SELECT count(*) AS c FROM claims")
      .get() as { c: number };
    expect(c).toBe(0); // a reject never enters the system
  });
});
