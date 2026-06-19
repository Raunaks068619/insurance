// app/src/domain/state-machines/claim-state.ts — claim lifecycle transitions + guards + aggregation

import type { ClaimStatus } from "../entities/claim";
import type { LineItemStatus } from "../entities/line-item";
import type { ReasonCode } from "../reason-codes";

// The only fields claim aggregation reads from a line's adjudicated outcome: its terminal
// status and its reason codes (the latter distinguishes a clean APPROVED from a straddle).
export type LineOutcome = { status: LineItemStatus; reasons: ReasonCode[] };

// Derive the claim status from its line outcomes — claim status is DERIVED, never set directly.
//
// Derive the claim status from its line outcomes:
//   all DENIED                                  → DENIED            (cycle 23)
//   any DENIED, or any straddled-partial line   → PARTIALLY_APPROVED (cycles 24–25)
//   otherwise (every line fully APPROVED)        → APPROVED          (cycle 22)
// A straddled line is itself APPROVED but carries LIMIT_EXCEEDED (its plan pay was capped at
// the remaining dollar limit and the shortfall fell to the member) — a partial payout.
export function aggregateClaimStatus(lines: LineOutcome[]): ClaimStatus {
  if (lines.every((line) => line.status === "DENIED")) return "DENIED";

  const anyDenied = lines.some((line) => line.status === "DENIED");
  const anyStraddled = lines.some(
    (line) => line.status === "APPROVED" && line.reasons.includes("LIMIT_EXCEEDED"),
  );
  if (anyDenied || anyStraddled) return "PARTIALLY_APPROVED";

  return "APPROVED";
}
