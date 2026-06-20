// app/src/repositories/status-transition.repository.ts — append-only status-transition log.
// Only ever INSERTs — append-only is enforced by triggers in schema.sql.

import { randomUUID } from "node:crypto";
import type { Db } from "../db/connection";
import { statusTransitions } from "../db/schema";

export type TransitionActor = "SYSTEM" | "MEMBER";
export type TransitionReason = "SUBMIT" | "ADJUDICATED" | "AGGREGATED" | "DISPUTE_REOPEN";

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

export function createStatusTransitionRepository(db: Db) {
  return {
    db,
    append(t: NewTransition): void {
      db.insert(statusTransitions)
        .values({ id: randomUUID(), ...t })
        .run();
    },
  };
}

export type StatusTransitionRepository = ReturnType<
  typeof createStatusTransitionRepository
>;
