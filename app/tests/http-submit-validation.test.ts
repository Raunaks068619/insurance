import { describe, expect, it } from "vitest";
import { freshDb, makeApp, seedWorld } from "./db-helpers";

// Intake structural validation (PRD N2): a malformed body is rejected at the edge with HTTP 400
// and { errors: [{ field, code, message }] }, and NOTHING is persisted (there is no REJECTED
// state — a reject never enters the system). Validation runs before the handler, so the service
// is never called.

describe("POST /claims — input validation (intake reject, N2)", () => {
  const appWithSeed = () => {
    const handle = freshDb();
    const { memberId } = seedWorld(handle.db, {
      rules: [
        { serviceCode: "PREVENTIVE", costShare: { type: "full_coverage" } },
      ],
    });
    return { handle, app: makeApp(handle), memberId };
  };

  const fieldsOf = (body: unknown) =>
    (body as { errors: Array<{ field: string }> }).errors
      .map((e) => e.field)
      .join(",");

  it("rejects a claim with no line items as 400 with field errors, and persists nothing", async () => {
    const { handle, app, memberId } = appWithSeed();

    const res = await app.inject({
      method: "POST",
      url: "/claims",
      payload: { memberId, serviceDate: "2026-06-19", lineItems: [] },
    });

    expect(res.statusCode).toBe(400);
    const errors = res.json().errors;
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toHaveProperty("field");
    expect(errors[0]).toHaveProperty("code");
    expect(errors[0]).toHaveProperty("message");

    const { c } = handle.sqlite
      .prepare("SELECT count(*) AS c FROM claims")
      .get() as { c: number };
    expect(c).toBe(0); // nothing entered the system
  });

  it("rejects a missing memberId as 400 naming the field", async () => {
    const { app } = appWithSeed();

    const res = await app.inject({
      method: "POST",
      url: "/claims",
      payload: {
        serviceDate: "2026-06-19",
        lineItems: [{ serviceCode: "PREVENTIVE", billedCents: 12_000 }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(fieldsOf(res.json())).toMatch(/memberId/);
  });

  it("rejects a non-positive billedCents as 400 naming the line field", async () => {
    const { app, memberId } = appWithSeed();

    const res = await app.inject({
      method: "POST",
      url: "/claims",
      payload: {
        memberId,
        serviceDate: "2026-06-19",
        lineItems: [{ serviceCode: "PREVENTIVE", billedCents: 0 }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(fieldsOf(res.json())).toMatch(/billedCents/);
  });
});
