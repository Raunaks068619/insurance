import { describe, expect, it } from "vitest";
import { createClaimRepository } from "../src/repositories/claim.repository";
import { DisputeError } from "../src/services/dispute.service";
import {
  freshDb,
  makeClaimService,
  makeDisputeService,
  seedWorld,
} from "./db-helpers";

// Cycles 32–36 — the dispute outcome taxonomy + the net-out invariant + the guards.
// outcome = diff(new vs original): OVERTURNED · UPHELD · MODIFIED · PARTIALLY_OVERTURNED.

const lineId = (sqlite: ReturnType<typeof freshDb>["sqlite"]) =>
  (sqlite.prepare("SELECT id FROM line_items").get() as { id: string }).id;

const readAcc = (sqlite: ReturnType<typeof freshDb>["sqlite"]) =>
  Object.fromEntries(
    (
      sqlite
        .prepare("SELECT dimension, used_cents FROM accumulators")
        .all() as {
        dimension: string;
        used_cents: number;
      }[]
    ).map((r) => [r.dimension, r.used_cents]),
  );

const errorFrom = (fn: () => unknown): DisputeError | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof DisputeError ? e : undefined;
  }
};

describe("disputeService.open — corrected prior_auth flips a denial → OVERTURNED (cycle 32)", () => {
  it("re-adjudicates a PRIOR_AUTH_REQUIRED denial to APPROVED with positive payable", () => {
    const { db, sqlite } = freshDb();
    const { memberId } = seedWorld(db, {
      rules: [
        {
          serviceCode: "MRI",
          costShare: { type: "coinsurance", rate: 0.2 },
          appliesDeductible: true,
          requiresPriorAuth: true,
        },
      ],
    });
    makeClaimService({ db, sqlite }).adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [
        { serviceCode: "MRI", billedCents: 90_000, priorAuthPresent: false },
      ],
    });

    const result = makeDisputeService({ db, sqlite }).open({
      lineItemId: lineId(sqlite),
      reason: "prior auth was on file",
      corrected: { priorAuthPresent: true },
    });

    expect(result.outcome).toBe("OVERTURNED");
    const resolved = sqlite
      .prepare("SELECT status, payable_cents FROM adjudications WHERE seq = 2")
      .get() as { status: string; payable_cents: number };
    expect(resolved.status).toBe("APPROVED");
    expect(resolved.payable_cents).toBeGreaterThan(0);
  });
});

describe("disputeService.open — no corrected facts → UPHELD (cycle 33)", () => {
  it("a deterministic re-run reaches the identical decision → UPHELD (original still preserved)", () => {
    const { db, sqlite } = freshDb();
    const { memberId } = seedWorld(db, {
      rules: [
        {
          serviceCode: "PCP_VISIT",
          costShare: { type: "copay", copayCents: 2_500 },
        },
      ],
    });
    makeClaimService({ db, sqlite }).adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [{ serviceCode: "PCP_VISIT", billedCents: 18_000 }],
    });

    const result = makeDisputeService({ db, sqlite }).open({
      lineItemId: lineId(sqlite),
      reason: "please re-review",
    });

    expect(result.outcome).toBe("UPHELD");
    const adjs = sqlite
      .prepare(
        "SELECT seq, status, payable_cents FROM adjudications ORDER BY seq",
      )
      .all() as { seq: number; status: string; payable_cents: number }[];
    expect(adjs).toHaveLength(2); // a new decision is still appended; the original is preserved
    expect(adjs[0]?.payable_cents).toBe(15_500);
    expect(adjs[1]?.payable_cents).toBe(15_500); // identical re-run
  });
});

describe("disputeService.open — corrected billed keeps APPROVED but changes numbers → MODIFIED (cycle 34)", () => {
  it("a corrected billed amount re-prices the same APPROVED line → MODIFIED", () => {
    const { db, sqlite } = freshDb();
    const { memberId } = seedWorld(db, {
      rules: [
        {
          serviceCode: "PCP_VISIT",
          costShare: { type: "copay", copayCents: 2_500 },
        },
      ],
    });
    makeClaimService({ db, sqlite }).adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [{ serviceCode: "PCP_VISIT", billedCents: 18_000 }],
    });

    const result = makeDisputeService({ db, sqlite }).open({
      lineItemId: lineId(sqlite),
      reason: "billed amount was wrong",
      corrected: { billedCents: 25_000 },
    });

    expect(result.outcome).toBe("MODIFIED");
    const resolved = sqlite
      .prepare("SELECT status, payable_cents FROM adjudications WHERE seq = 2")
      .get() as { status: string; payable_cents: number };
    expect(resolved.status).toBe("APPROVED"); // still approved
    expect(resolved.payable_cents).toBe(22_500); // $250 − $25 copay (was $155)
  });
});

describe("disputeService.open — net-out keeps the accumulator invariant (cycle 35)", () => {
  it("re-adjudicates against current − original deltas, so a dimension reflects only the latest decision", () => {
    const { db, sqlite } = freshDb();
    const { memberId } = seedWorld(db, {
      rules: [
        {
          serviceCode: "MRI",
          costShare: { type: "coinsurance", rate: 0.2 },
          appliesDeductible: true,
        },
      ],
    });
    makeClaimService({ db, sqlite }).adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [{ serviceCode: "MRI", billedCents: 90_000 }],
    });
    // original $900: $500 deductible + 20% of $400 = $80 → OOP $580
    expect(readAcc(sqlite)).toMatchObject({ DEDUCTIBLE: 50_000, OOP: 58_000 });

    makeDisputeService({ db, sqlite }).open({
      lineItemId: lineId(sqlite),
      reason: "billed amount was overstated",
      corrected: { billedCents: 60_000 },
    });
    // re-adjudicated $600: $500 deductible + 20% of $100 = $20 → OOP $520.
    // The dimensions reflect ONLY the latest decision — never original+new double-counted.
    expect(readAcc(sqlite)).toMatchObject({ DEDUCTIBLE: 50_000, OOP: 52_000 });
  });
});

describe("disputeService.open — guards (cycle 36)", () => {
  it("rejects a dispute on a missing line with NOT_FOUND (404)", () => {
    const { db, sqlite } = freshDb();
    seedWorld(db, {
      rules: [
        { serviceCode: "PREVENTIVE", costShare: { type: "full_coverage" } },
      ],
    });
    const err = errorFrom(() =>
      makeDisputeService({ db, sqlite }).open({
        lineItemId: "li_missing",
        reason: "x",
      }),
    );
    expect(err?.code).toBe("NOT_FOUND");
  });

  it("rejects a dispute on a non-terminal (PENDING) line with CONFLICT (409)", () => {
    const { db, sqlite } = freshDb();
    const { memberId, policyId } = seedWorld(db, {
      rules: [
        { serviceCode: "PREVENTIVE", costShare: { type: "full_coverage" } },
      ],
    });
    const claims = createClaimRepository(db);
    const claimId = claims.insertClaim({
      memberId,
      policyId,
      serviceDate: "2026-06-19",
    });
    const pending = claims.insertLine(claimId, {
      serviceCode: "PREVENTIVE",
      billedCents: 12_000,
      fingerprint: "fp",
    });

    const err = errorFrom(() =>
      makeDisputeService({ db, sqlite }).open({
        lineItemId: pending.id,
        reason: "x",
      }),
    );
    expect(err?.code).toBe("CONFLICT");
  });

  it("a dollar-straddle dispute restores a partial payable → PARTIALLY_OVERTURNED", () => {
    const { db, sqlite } = freshDb();
    const { memberId } = seedWorld(db, {
      rules: [
        {
          serviceCode: "CHIROPRACTIC",
          costShare: { type: "full_coverage" },
          limit: { unit: "dollars", amountCents: 10_000 }, // only $100/yr left to pay
          requiresPriorAuth: true,
        },
      ],
    });
    makeClaimService({ db, sqlite }).adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [
        {
          serviceCode: "CHIROPRACTIC",
          billedCents: 30_000,
          priorAuthPresent: false,
        },
      ],
    });

    const result = makeDisputeService({ db, sqlite }).open({
      lineItemId: lineId(sqlite),
      reason: "auth on file",
      corrected: { priorAuthPresent: true },
    });

    expect(result.outcome).toBe("PARTIALLY_OVERTURNED");
    const resolved = sqlite
      .prepare(
        "SELECT status, payable_cents, reasons_json FROM adjudications WHERE seq = 2",
      )
      .get() as { status: string; payable_cents: number; reasons_json: string };
    expect(resolved.status).toBe("APPROVED");
    expect(resolved.payable_cents).toBe(10_000); // plan capped at the remaining $100 limit
    expect(JSON.parse(resolved.reasons_json)).toContain("LIMIT_EXCEEDED");
  });
});
