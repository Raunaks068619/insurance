// app/src/repositories/status-transition.repository.ts — append-only status-transition log.
// Only ever INSERTs — append-only is enforced by triggers in schema.sql.

import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/connection";
import { statusTransitions } from "../db/schema";

export type TransitionActor = "SYSTEM" | "MEMBER";
export type TransitionReason =
  | "SUBMIT"
  | "ADJUDICATED"
  | "AGGREGATED"
  | "DISPUTE_REOPEN";

export type NewTransition = {
  entityType: "CLAIM" | "LINE_ITEM";
  claimId: string; // the owning claim aggregate — always set
  lineItemId: string | null; // set iff entityType === LINE_ITEM
  fromStatus: string | null; // null on create
  toStatus: string;
  actor: TransitionActor;
  reason: TransitionReason;
  seq: number; // claim-aggregate logical clock
};

// One row of the member-facing lifecycle timeline (the merged claim + line-item history).
export type TransitionRecord = {
  entityType: "CLAIM" | "LINE_ITEM";
  entityId: string; // the line-item id for LINE_ITEM rows, else the claim id
  fromStatus: string | null;
  toStatus: string;
  actor: TransitionActor;
  reason: TransitionReason;
  seq: number;
};

export function createStatusTransitionRepository(db: Db) {
  return {
    db,
    append(t: NewTransition): void {
      db.insert(statusTransitions)
        .values({ id: randomUUID(), ...t })
        .run();
    },

    // The claim aggregate's full status history, in logical-clock order — its `timeline`.
    byClaimId(claimId: string): TransitionRecord[] {
      const rows = db
        .select()
        .from(statusTransitions)
        .where(eq(statusTransitions.claimId, claimId))
        .orderBy(asc(statusTransitions.seq))
        .all();
      return rows.map((r) => ({
        entityType: r.entityType,
        entityId: r.lineItemId ?? r.claimId,
        fromStatus: r.fromStatus,
        toStatus: r.toStatus,
        actor: r.actor,
        reason: r.reason,
        seq: r.seq,
      }));
    },
  };
}

export type StatusTransitionRepository = ReturnType<
  typeof createStatusTransitionRepository
>;
