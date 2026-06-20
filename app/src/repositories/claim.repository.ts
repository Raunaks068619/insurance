// app/src/repositories/claim.repository.ts — claims + line-items persistence (Drizzle typed queries).

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/connection";
import { decryptPhiNullable, encryptPhiNullable } from "../db/phi-crypto";
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

export type LineRecord = {
  id: string;
  claimId: string;
  serviceCode: string;
  billedCents: number;
  units: number;
  priorAuthPresent: boolean;
  status: LineItemStatus;
  fingerprint: string;
};

export type ClaimRecord = {
  id: string;
  memberId: string;
  policyId: string;
  serviceDate: string;
  status: ClaimStatus;
};

// Decrypted PHI for a claim — kept off ClaimRecord so the common read path never touches PHI.
export type ClaimPhi = {
  provider: string | null;
  diagnosisCode: string | null;
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
          // provider/diagnosis_code are PHI — encrypted at rest (null stays null).
          provider: encryptPhiNullable(c.provider),
          diagnosisCode: encryptPhiNullable(c.diagnosisCode),
        })
        .run();
      return id;
    },

    insertLine(claimId: string, l: NewLine): PersistedLine {
      const id = randomUUID(); // status defaults to PENDING
      const units = l.units ?? 1;
      // Fail-closed: an omitted priorAuthPresent means auth was NOT obtained, so a prior-auth
      // service denies PRIOR_AUTH_REQUIRED rather than silently paying (reversed default).
      const priorAuthPresent = l.priorAuthPresent ?? false;
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

    // Advance the claim's logical clock (the head for status_transitions.seq) and return it.
    bumpClaimSeq(claimId: string): number {
      const row = db
        .select({ seq: claims.claimSeq })
        .from(claims)
        .where(eq(claims.id, claimId))
        .get();
      const next = (row?.seq ?? 0) + 1;
      db.update(claims)
        .set({ claimSeq: next })
        .where(eq(claims.id, claimId))
        .run();
      return next;
    },

    findLineById(id: string): LineRecord | undefined {
      const row = db.select().from(lineItems).where(eq(lineItems.id, id)).get();
      if (!row) return undefined;
      return {
        id: row.id,
        claimId: row.claimId,
        serviceCode: row.serviceCode,
        billedCents: row.billedCents,
        units: row.units,
        priorAuthPresent: row.priorAuthPresent,
        status: row.status,
        fingerprint: row.fingerprint,
      };
    },

    findClaimById(id: string): ClaimRecord | undefined {
      const row = db.select().from(claims).where(eq(claims.id, id)).get();
      if (!row) return undefined;
      return {
        id: row.id,
        memberId: row.memberId,
        policyId: row.policyId,
        serviceDate: row.serviceDate,
        status: row.status,
      };
    },

    // Decrypt a claim's PHI (provider/diagnosis). Separate from findClaimById so PHI is read only
    // when explicitly needed — never on the hot adjudication/read path.
    findClaimPhi(id: string): ClaimPhi | undefined {
      const row = db
        .select({
          provider: claims.provider,
          diagnosisCode: claims.diagnosisCode,
        })
        .from(claims)
        .where(eq(claims.id, id))
        .get();
      if (!row) return undefined;
      return {
        provider: decryptPhiNullable(row.provider),
        diagnosisCode: decryptPhiNullable(row.diagnosisCode),
      };
    },
  };
}

export type ClaimRepository = ReturnType<typeof createClaimRepository>;
