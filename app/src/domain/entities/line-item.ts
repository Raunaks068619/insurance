// app/src/domain/entities/line-item.ts — LineItem entity + its lifecycle status.
// PENDING -> { APPROVED | DENIED }; NEEDS_REVIEW is reached only via a dispute reopen.
export type LineItemStatus = "PENDING" | "APPROVED" | "DENIED" | "NEEDS_REVIEW";

export type LineItem = {
  id: string;
  claimId: string;
  serviceCode: string;
  billedCents: number; // positive integer cents (allowed == billed in v1)
  units: number;
  priorAuthPresent: boolean; // default false (absence = auth NOT obtained, fail-closed)
  status: LineItemStatus;
  fingerprint: string; // memberId + serviceCode + serviceDate + billedCents
};
