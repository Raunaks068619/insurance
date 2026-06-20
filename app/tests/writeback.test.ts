import { describe, expect, it } from "vitest";
import { freshDb, makeClaimService, seedWorld } from "./db-helpers";

// Cycle 26 — a full claim runs through the real SQLite store: it persists (claim + lines +
// one adjudication per line), advances the accumulators, writes adjudications append-only, and
// does it all in ONE transaction (a mid-write failure leaves nothing behind).

describe("adjudicateClaim — full-claim writeback (cycle 26)", () => {
  // Two covered lines: PREVENTIVE (full coverage, no member share) + PCP_VISIT ($25 copay → OOP).
  const seedAndAdjudicate = () => {
    const { db, sqlite } = freshDb();
    const { memberId } = seedWorld(db, {
      rules: [
        { serviceCode: "PREVENTIVE", costShare: { type: "full_coverage" } },
        {
          serviceCode: "PCP_VISIT",
          costShare: { type: "copay", copayCents: 2_500 },
        },
      ],
    });
    const service = makeClaimService({ db, sqlite });
    service.adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [
        { serviceCode: "PREVENTIVE", billedCents: 12_000 },
        { serviceCode: "PCP_VISIT", billedCents: 18_000 },
      ],
    });
    return { db, sqlite };
  };

  it("persists the claim, its line items, and one adjudication per line", () => {
    const { sqlite } = seedAndAdjudicate();

    const claimRows = sqlite.prepare("SELECT * FROM claims").all() as {
      status: string;
    }[];
    const lineRows = sqlite.prepare("SELECT * FROM line_items").all();
    const adjRows = sqlite.prepare("SELECT * FROM adjudications").all();

    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]?.status).toBe("APPROVED"); // both lines approved → claim APPROVED
    expect(lineRows).toHaveLength(2);
    expect(adjRows).toHaveLength(2); // exactly one decision per line
  });

  it("advances and persists the OOP accumulator by the copay amount", () => {
    const { sqlite } = seedAndAdjudicate();

    const oop = sqlite
      .prepare("SELECT used_cents FROM accumulators WHERE dimension = 'OOP'")
      .get() as { used_cents: number } | undefined;
    expect(oop?.used_cents).toBe(2_500); // the $25 copay accrued to OOP
  });

  it("writes adjudications append-only — a direct UPDATE is rejected by the DB", () => {
    const { sqlite } = seedAndAdjudicate();

    expect(() =>
      sqlite.exec("UPDATE adjudications SET payable_cents = 0"),
    ).toThrow(/append-only/);
  });

  it("adjudicates the whole claim in ONE transaction — a mid-write failure rolls back everything", () => {
    const { db, sqlite } = freshDb();
    const { memberId } = seedWorld(db, {
      rules: [
        { serviceCode: "PREVENTIVE", costShare: { type: "full_coverage" } },
        {
          serviceCode: "PCP_VISIT",
          costShare: { type: "copay", copayCents: 2_500 },
        },
      ],
    });

    // Sabotage the second adjudication write to simulate a failure partway through the claim.
    const base = makeClaimService({ db, sqlite });
    let appendCalls = 0;
    const service = makeClaimService(
      { db, sqlite },
      {
        adjudications: {
          ...base.adjudications,
          append: (...args: unknown[]) => {
            appendCalls += 1;
            if (appendCalls === 2)
              throw new Error("simulated mid-claim failure");
            return (
              base.adjudications as { append: (...a: unknown[]) => unknown }
            ).append(...args);
          },
        } as typeof base.adjudications,
      },
    );

    expect(() =>
      service.adjudicateClaim({
        memberId,
        serviceDate: "2026-06-19",
        lineItems: [
          { serviceCode: "PREVENTIVE", billedCents: 12_000 },
          { serviceCode: "PCP_VISIT", billedCents: 18_000 },
        ],
      }),
    ).toThrow(/simulated mid-claim failure/);

    // Nothing persisted — the whole claim rolled back as one unit.
    const counts = (table: string) =>
      (sqlite.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number })
        .c;
    expect(counts("claims")).toBe(0);
    expect(counts("line_items")).toBe(0);
    expect(counts("adjudications")).toBe(0);
    expect(counts("accumulators")).toBe(0);
  });
});
