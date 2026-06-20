import { describe, expect, it } from "vitest";
import { createClaimRepository } from "../src/repositories/claim.repository";
import {
  freshDb,
  makeClaimService,
  makeDisputeService,
  makeSetStatus,
  seedWorld,
} from "./db-helpers";

// Cycles 28–31 — the append-only status-transition log. ONE setStatus() chokepoint updates the
// status column AND appends a transition row in the same write; `seq` is a per-claim logical clock.

describe("setStatus — chokepoint appends a transition row (cycle 28)", () => {
  it("appends a CLAIM transition with from=null on create, sets the column, and bumps seq", () => {
    const { db, sqlite } = freshDb();
    const { memberId, policyId } = seedWorld(db, {
      rules: [
        { serviceCode: "PREVENTIVE", costShare: { type: "full_coverage" } },
      ],
    });
    const claimId = createClaimRepository(db).insertClaim({
      memberId,
      policyId,
      serviceDate: "2026-06-19",
    });

    makeSetStatus({ db, sqlite })({
      claimId,
      target: { type: "CLAIM", status: "SUBMITTED" },
      fromStatus: null,
      actor: "SYSTEM",
      reason: "SUBMIT",
    });

    const rows = sqlite
      .prepare(
        "SELECT * FROM status_transitions WHERE claim_id = ? ORDER BY seq",
      )
      .all(claimId) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity_type: "CLAIM",
      from_status: null,
      to_status: "SUBMITTED",
      actor: "SYSTEM",
      reason: "SUBMIT",
      seq: 1,
    });
    expect(rows[0]?.line_item_id).toBeNull();

    const claim = sqlite
      .prepare("SELECT status, claim_seq FROM claims WHERE id = ?")
      .get(claimId) as { status: string; claim_seq: number };
    expect(claim).toMatchObject({ status: "SUBMITTED", claim_seq: 1 });
  });
});

describe("adjudicateClaim — logs the ordered submit→adjudicate→aggregate set (cycle 29)", () => {
  const adjudicateTwoLine = () => {
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
    makeClaimService({ db, sqlite }).adjudicateClaim({
      memberId,
      serviceDate: "2026-06-19",
      lineItems: [
        { serviceCode: "PREVENTIVE", billedCents: 12_000 },
        { serviceCode: "PCP_VISIT", billedCents: 18_000 },
      ],
    });
    return sqlite;
  };

  it("records claim SUBMIT, two line SUBMITs, two line ADJUDICATEDs, claim AGGREGATED in seq order", () => {
    const sqlite = adjudicateTwoLine();
    const rows = sqlite
      .prepare(
        "SELECT entity_type, reason, to_status, seq FROM status_transitions ORDER BY seq",
      )
      .all() as {
      entity_type: string;
      reason: string;
      to_status: string;
      seq: number;
    }[];

    expect(rows.map((r) => [r.entity_type, r.reason])).toEqual([
      ["CLAIM", "SUBMIT"],
      ["LINE_ITEM", "SUBMIT"],
      ["LINE_ITEM", "SUBMIT"],
      ["LINE_ITEM", "ADJUDICATED"],
      ["LINE_ITEM", "ADJUDICATED"],
      ["CLAIM", "AGGREGATED"],
    ]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]); // one monotonic clock per claim
    expect(rows.at(-1)).toMatchObject({
      reason: "AGGREGATED",
      to_status: "APPROVED",
    });
  });
});

describe("adjudicateClaim — re-run yields identical transition rows (cycle 30)", () => {
  it("is deterministic modulo surrogate ids + created_at", () => {
    const cols = "entity_type, from_status, to_status, actor, reason, seq";
    const run = () => {
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
      makeClaimService({ db, sqlite }).adjudicateClaim({
        memberId,
        serviceDate: "2026-06-19",
        lineItems: [
          { serviceCode: "PREVENTIVE", billedCents: 12_000 },
          { serviceCode: "PCP_VISIT", billedCents: 18_000 },
        ],
      });
      return sqlite
        .prepare(`SELECT ${cols} FROM status_transitions ORDER BY seq`)
        .all();
    };
    expect(run()).toEqual(run());
  });
});

describe("disputeService.open — logs the reopen + re-adjudication (cycle 31)", () => {
  it("logs the line DENIED→NEEDS_REVIEW (MEMBER, DISPUTE_REOPEN) then NEEDS_REVIEW→APPROVED", () => {
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
    const lineItemId = (
      sqlite.prepare("SELECT id FROM line_items").get() as { id: string }
    ).id;
    makeDisputeService({ db, sqlite }).open({
      lineItemId,
      reason: "auth on file",
      corrected: { priorAuthPresent: true },
    });

    const lineRows = sqlite
      .prepare(
        "SELECT from_status, to_status, actor, reason FROM status_transitions WHERE entity_type = 'LINE_ITEM' ORDER BY seq",
      )
      .all() as {
      from_status: string;
      to_status: string;
      actor: string;
      reason: string;
    }[];

    // the dispute reopen: terminal DENIED → NEEDS_REVIEW, by the MEMBER
    const reopenIdx = lineRows.findIndex((r) => r.reason === "DISPUTE_REOPEN");
    expect(lineRows[reopenIdx]).toMatchObject({
      from_status: "DENIED",
      to_status: "NEEDS_REVIEW",
      actor: "MEMBER",
    });
    // the auto re-adjudication right after: NEEDS_REVIEW → APPROVED, by the SYSTEM
    expect(lineRows[reopenIdx + 1]).toMatchObject({
      from_status: "NEEDS_REVIEW",
      to_status: "APPROVED",
      actor: "SYSTEM",
      reason: "ADJUDICATED",
    });
  });
});
