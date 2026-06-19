// app/src/domain/entities/claim.ts — Claim entity type (status, fingerprint)

// The claim lifecycle status. DERIVED from the line items (see aggregateClaimStatus),
// never set directly. UNDER_REVIEW is transient; the other three are terminal in v1
// (no PAID state — decision #14).
export type ClaimStatus =
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "PARTIALLY_APPROVED"
  | "DENIED";
