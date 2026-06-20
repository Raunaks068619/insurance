// app/src/repositories/adjudication.repository.ts — append-only adjudication persistence.
// Only ever INSERTs — append-only is enforced by triggers in schema.sql.

import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/connection";
import { adjudications } from "../db/schema";
import type { ReasonCode } from "../domain/reason-codes";

export type NewAdjudication = {
  lineItemId: string;
  planYear: string;
  seq: number; // per-line clock; 1 for the first decision, higher for a dispute re-adjudication
  status: "APPROVED" | "DENIED";
  billedCents: number;
  payableCents: number;
  memberResponsibilityCents: number;
  reasons: ReasonCode[];
  explanation: string;
  deltas: { deductibleIncCents: number; oopIncCents: number; limitInc: number };
};

export type CurrentAdjudication = {
  id: string;
  seq: number;
  status: "APPROVED" | "DENIED";
  payableCents: number;
  memberResponsibilityCents: number;
  reasons: ReasonCode[];
  explanation: string;
  deltas: { deductibleIncCents: number; oopIncCents: number; limitInc: number };
};

// One line's current (max-seq) decision, with the EOB fields a claim explanation needs.
export type ClaimAdjudicationLine = {
  lineItemId: string;
  serviceCode: string;
  billedCents: number;
  status: "APPROVED" | "DENIED";
  payableCents: number;
  memberResponsibilityCents: number;
  reasons: ReasonCode[];
  explanation: string;
};

export function createAdjudicationRepository(db: Db) {
  return {
    db,

    append(a: NewAdjudication): string {
      const id = randomUUID();
      db.insert(adjudications)
        .values({
          id,
          lineItemId: a.lineItemId,
          planYear: a.planYear,
          seq: a.seq,
          status: a.status,
          billedCents: a.billedCents,
          payableCents: a.payableCents,
          memberResponsibilityCents: a.memberResponsibilityCents,
          reasonsJson: a.reasons,
          explanation: a.explanation,
          deltaDeductibleIncCents: a.deltas.deductibleIncCents,
          deltaOopIncCents: a.deltas.oopIncCents,
          deltaLimitInc: a.deltas.limitInc,
        })
        .run();
      return id;
    },

    // The current (latest seq) decision for a line — the one a dispute challenges.
    currentForLine(lineItemId: string): CurrentAdjudication | undefined {
      const row = db
        .select()
        .from(adjudications)
        .where(eq(adjudications.lineItemId, lineItemId))
        .orderBy(desc(adjudications.seq))
        .limit(1)
        .get();
      if (!row) return undefined;
      return {
        id: row.id,
        seq: row.seq,
        status: row.status,
        payableCents: row.payableCents,
        memberResponsibilityCents: row.memberResponsibilityCents,
        reasons: row.reasonsJson,
        explanation: row.explanation,
        deltas: {
          deductibleIncCents: row.deltaDeductibleIncCents,
          oopIncCents: row.deltaOopIncCents,
          limitInc: row.deltaLimitInc,
        },
      };
    },

    // Each line's CURRENT decision (its max-seq adjudication) for one claim — for re-aggregation.
    currentOutcomesByClaim(
      claimId: string,
    ): { status: "APPROVED" | "DENIED"; reasons: ReasonCode[] }[] {
      const rows = db.all<{
        status: "APPROVED" | "DENIED";
        reasons_json: string;
      }>(sql`
        SELECT a.status AS status, a.reasons_json AS reasons_json
        FROM line_items li
        JOIN adjudications a ON a.line_item_id = li.id
        WHERE li.claim_id = ${claimId}
          AND a.seq = (SELECT MAX(seq) FROM adjudications WHERE line_item_id = li.id)
      `);
      return rows.map((r) => ({
        status: r.status,
        reasons: JSON.parse(r.reasons_json) as ReasonCode[],
      }));
    },

    // Each line's CURRENT decision (its max-seq adjudication) for one claim, with the full
    // EOB payload — feeds GET /claims/:id/explanation and the claim-level payable sum.
    byClaimId(claimId: string): ClaimAdjudicationLine[] {
      const rows = db.all<{
        line_item_id: string;
        service_code: string;
        billed_cents: number;
        status: "APPROVED" | "DENIED";
        payable_cents: number;
        member_responsibility_cents: number;
        reasons_json: string;
        explanation: string;
      }>(sql`
        SELECT li.id AS line_item_id,
               li.service_code AS service_code,
               a.billed_cents AS billed_cents,
               a.status AS status,
               a.payable_cents AS payable_cents,
               a.member_responsibility_cents AS member_responsibility_cents,
               a.reasons_json AS reasons_json,
               a.explanation AS explanation
        FROM line_items li
        JOIN adjudications a ON a.line_item_id = li.id
        WHERE li.claim_id = ${claimId}
          AND a.seq = (SELECT MAX(seq) FROM adjudications WHERE line_item_id = li.id)
        ORDER BY li.created_at, li.id
      `);
      return rows.map((r) => ({
        lineItemId: r.line_item_id,
        serviceCode: r.service_code,
        billedCents: r.billed_cents,
        status: r.status,
        payableCents: r.payable_cents,
        memberResponsibilityCents: r.member_responsibility_cents,
        reasons: JSON.parse(r.reasons_json) as ReasonCode[],
        explanation: r.explanation,
      }));
    },
  };
}

export type AdjudicationRepository = ReturnType<
  typeof createAdjudicationRepository
>;
