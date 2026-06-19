// app/src/domain/rules/coverage-rule.ts — CoverageRule: typed config data, not a DSL.
// cost_share and limit are discriminated unions — exactly one mechanism / unit each.

export type CostShare =
  | { type: "full_coverage" }
  | { type: "copay"; copayCents: number }
  | { type: "coinsurance"; rate: number }; // member share, 0.0–1.0

export type CoverageLimit =
  | { unit: "none" }
  | { unit: "dollars"; amountCents: number } // "$Y per year"
  | { unit: "visits"; count: number }; // "20 visits per year"

export type CoverageRule = {
  policyId: string;
  serviceCode: string;
  covered: boolean;
  excluded: boolean; // explicit exclusion beats "covered"
  costShare: CostShare;
  appliesDeductible: boolean;
  limit: CoverageLimit;
  requiresPriorAuth: boolean;
};
