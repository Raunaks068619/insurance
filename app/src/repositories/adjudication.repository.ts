// app/src/repositories/adjudication.repository.ts — append-only adjudication persistence.
// Only ever INSERTs — append-only is enforced by triggers in schema.sql.


import { randomUUID } from "node:crypto";
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
  };
}

export type AdjudicationRepository = ReturnType<
  typeof createAdjudicationRepository
>;
