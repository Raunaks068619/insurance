import { describe, expect, it } from "vitest";
import { freshDb, makeApp, seedWorld } from "./db-helpers";

// POST /claims/:id/line-items/:lid/dispute reopens a terminal line, re-adjudicates it against
// current rules + corrected facts (single-line accumulator net-out), preserves the original
// decision immutably, and resolves to a 4-value outcome. Identity/state guards map to 4xx:
// a missing line -> 404. Adjudication results themselves stay 200 (a denial is not an error).

describe("POST /claims/:id/line-items/:lid/dispute — dispute a line decision", () => {
  // MRI: 20% coinsurance after deductible, prior auth REQUIRED. Submitting without prior auth
  // denies the line; supplying it on dispute overturns to an approval.
  const appWithDeniedMri = async () => {
    const handle = freshDb();
    const { memberId } = seedWorld(handle.db, {
      deductibleCents: 50_000,
      oopMaxCents: 300_000,
      rules: [
        {
          serviceCode: "MRI",
          costShare: { type: "coinsurance", rate: 0.2 },
          appliesDeductible: true,
          requiresPriorAuth: true,
        },
      ],
    });
    const app = makeApp(handle);

    const submitted = (
      await app.inject({
        method: "POST",
        url: "/claims",
        payload: {
          memberId,
          serviceDate: "2026-06-19",
          lineItems: [
            {
              serviceCode: "MRI",
              billedCents: 100_000,
              priorAuthPresent: false,
            },
          ],
        },
      })
    ).json();

    return {
      handle,
      app,
      claimId: submitted.id as string,
      lineItemId: submitted.lineItems[0].lineItemId as string,
    };
  };

  it("overturns a prior-auth denial when the dispute supplies the missing auth", async () => {
    const { handle, app, claimId, lineItemId } = await appWithDeniedMri();

    const res = await app.inject({
      method: "POST",
      url: `/claims/${claimId}/line-items/${lineItemId}/dispute`,
      payload: {
        reason: "prior authorization was on file",
        corrected: { priorAuthPresent: true },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outcome).toBe("OVERTURNED");

    // the disputed line now reads APPROVED with a real payable (100.00 billed, 50.00 deductible,
    // then 20% of the remaining 50.00 = 10.00 member → plan pays 40.00)
    const line = body.claim.lineItems.find(
      (l: { lineItemId: string }) => l.lineItemId === lineItemId,
    );
    expect(line.status).toBe("APPROVED");
    expect(line.payableCents).toBe(40_000);

    // history is preserved: the original DENIED decision + the new APPROVED one both exist
    const { c } = handle.sqlite
      .prepare("SELECT count(*) AS c FROM adjudications WHERE line_item_id = ?")
      .get(lineItemId) as { c: number };
    expect(c).toBe(2);
  });

  it("returns 404 when disputing a line item that does not exist", async () => {
    const { app, claimId } = await appWithDeniedMri();

    const res = await app.inject({
      method: "POST",
      url: `/claims/${claimId}/line-items/no-such-line/dispute`,
      payload: { reason: "typo in the URL" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});
