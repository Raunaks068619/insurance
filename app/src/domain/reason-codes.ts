// app/src/domain/reason-codes.ts — canonical ReasonCode vocabulary.
// Modeled as a const-object + union (NOT a runtime `enum`) so it survives the
// erasableSyntaxOnly tsconfig flag while keeping the same string values.
// One dominant code classifies each decision; the explanation carries the breakdown.

export const ReasonCode = {
  APPROVED: "APPROVED",
  NO_COVERAGE: "NO_COVERAGE",
  EXCLUDED: "EXCLUDED",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  DEDUCTIBLE_APPLIED: "DEDUCTIBLE_APPLIED",
  COPAY_APPLIED: "COPAY_APPLIED",
  COINSURANCE_APPLIED: "COINSURANCE_APPLIED",
  OOP_MAX_REACHED: "OOP_MAX_REACHED",
  PRIOR_AUTH_REQUIRED: "PRIOR_AUTH_REQUIRED",
  DUPLICATE_LINE_ITEM: "DUPLICATE_LINE_ITEM",
  POLICY_NOT_ACTIVE: "POLICY_NOT_ACTIVE",
  DISPUTED_OVERRIDE: "DISPUTED_OVERRIDE", // reserved for a v2 reviewer override; unused in v1
} as const;

export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode];
