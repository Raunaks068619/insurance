// app/src/repositories/claim.repository.ts — claims + line-items persistence (Drizzle typed queries).

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/connection";
import { claims, lineItems } from "../db/schema";
import type { ClaimStatus } from "../domain/entities/claim";
import type { LineItemStatus } from "../domain/entities/line-item";

export type NewClaim = {
  memberId: string;
  policyId: string;
  serviceDate: string;
  provider?: string | null;
  diagnosisCode?: string | null;
};

export type NewLine = {
  serviceCode: string;
  billedCents: number;
  units?: number | undefined;
  priorAuthPresent?: boolean | undefined;
  fingerprint: string;
};

export type PersistedLine = {
  id: string;
  serviceCode: string;
  billedCents: number;
  units: number;
  priorAuthPresent: boolean;
  fingerprint: string;
};

export function createClaimRepository(db: Db) {
  return {
    db,

    insertClaim(c: NewClaim): string {
      const id = randomUUID(); // status defaults to SUBMITTED; aggregated status set later
      db.insert(claims)
        .values({
          id,
          memberId: c.memberId,
          policyId: c.policyId,
          serviceDate: c.serviceDate,
          provider: c.provider ?? null,
          diagnosisCode: c.diagnosisCode ?? null,
        })
        .run();
      return id;
    },

    insertLine(claimId: string, l: NewLine): PersistedLine {
      const id = randomUUID(); // status defaults to PENDING
      const units = l.units ?? 1;
      const priorAuthPresent = l.priorAuthPresent ?? true;
      db.insert(lineItems)
        .values({
          id,
          claimId,
          serviceCode: l.serviceCode,
          billedCents: l.billedCents,
          units,
          priorAuthPresent,
          fingerprint: l.fingerprint,
        })
        .run();
      return {
        id,
        serviceCode: l.serviceCode,
        billedCents: l.billedCents,
        units,
        priorAuthPresent,
        fingerprint: l.fingerprint,
      };
    },

    setLineStatus(lineItemId: string, status: LineItemStatus): void {
      db.update(lineItems)
        .set({ status })
        .where(eq(lineItems.id, lineItemId))
        .run();
    },

    setClaimStatus(claimId: string, status: ClaimStatus): void {
      db.update(claims).set({ status }).where(eq(claims.id, claimId)).run();
    },
  };
}

export type ClaimRepository = ReturnType<typeof createClaimRepository>;
