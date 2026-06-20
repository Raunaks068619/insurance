// app/src/repositories/dispute.repository.ts — dispute persistence.
// A dispute is synchronous: it opens and resolves in one step (one transaction), so the repo only
// ever writes RESOLVED rows. Append-only on adjudications + the seq-order trigger guard the history.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../db/connection";
import { disputes } from "../db/schema";

export type DisputeOutcome =
  | "UPHELD"
  | "OVERTURNED"
  | "PARTIALLY_OVERTURNED"
  | "MODIFIED";

export type CorrectedFacts = {
  priorAuthPresent?: boolean;
  serviceCode?: string;
  billedCents?: number;
  units?: number;
};

export type ResolvedDispute = {
  lineItemId: string;
  originalAdjudicationId: string;
  resolvedAdjudicationId: string;
  reason: string;
  corrected?: CorrectedFacts | undefined;
  outcome: DisputeOutcome;
};

export function createDisputeRepository(db: Db) {
  return {
    db,
    insertResolved(d: ResolvedDispute): string {
      const id = randomUUID();
      const c = d.corrected ?? {};
      db.insert(disputes)
        .values({
          id,
          lineItemId: d.lineItemId,
          originalAdjudicationId: d.originalAdjudicationId,
          resolvedAdjudicationId: d.resolvedAdjudicationId,
          reason: d.reason,
          correctedPriorAuthPresent: c.priorAuthPresent ?? null,
          correctedServiceCode: c.serviceCode ?? null,
          correctedBilledCents: c.billedCents ?? null,
          correctedUnits: c.units ?? null,
          outcome: d.outcome,
          state: "RESOLVED",
          resolvedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        })
        .run();
      return id;
    },
  };
}

export type DisputeRepository = ReturnType<typeof createDisputeRepository>;
