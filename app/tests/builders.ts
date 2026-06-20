// app/tests/builders.ts — AAA builders. Each returns a fully-valid, camelCase,
// integer-cents object; a test overrides only the field(s) it asserts on, so the
// load-bearing fact of each test stands out and the rest recedes. No `any`.

import type {
  AccumulatorSnapshot,
  AdjudicateLineInput,
} from "../src/domain/adjudication/adjudicator";
import type { CoverageRule, LineItem, Policy } from "../src/domain/types";

export const aPolicy = (overrides: Partial<Policy> = {}): Policy => ({
  id: "pol_test_1",
  memberId: "mem_test_1",
  planYear: 2026,
  effectiveDate: "2026-01-01",
  terminationDate: "2026-12-31",
  deductibleCents: 50_000, // $500.00
  oopMaxCents: 300_000, // $3,000.00
  ...overrides,
});

export const aCoverageRule = (
  overrides: Partial<CoverageRule> = {},
): CoverageRule => ({
  policyId: "pol_test_1",
  serviceCode: "PREVENTIVE",
  covered: true,
  excluded: false,
  costShare: { type: "full_coverage" },
  appliesDeductible: false,
  limit: { unit: "none" },
  requiresPriorAuth: false,
  ...overrides,
});

export const aLineItem = (overrides: Partial<LineItem> = {}): LineItem => ({
  id: "li_test_1",
  claimId: "clm_test_1",
  serviceCode: "PREVENTIVE",
  billedCents: 12_000, // $120.00 — integer cents, never a float
  units: 1,
  // A fully-valid fixture line asserts auth WAS obtained. NOTE: production defaults an OMITTED
  // priorAuthPresent to `false` (fail-closed, decision #22) — prior-auth tests set this explicitly.
  priorAuthPresent: true,
  status: "PENDING",
  fingerprint: "mem_test_1|PREVENTIVE|2026-06-19|12000",
  ...overrides,
});

export const anAccumulator = (
  overrides: Partial<AccumulatorSnapshot> = {},
): AccumulatorSnapshot => ({
  deductibleMetCents: 0,
  oopMetCents: 0,
  limitUsed: 0,
  ...overrides,
});

export const anAdjudicateInput = (
  overrides: Partial<AdjudicateLineInput> = {},
): AdjudicateLineInput => ({
  line: aLineItem(),
  policy: aPolicy(),
  rule: aCoverageRule(),
  serviceDate: "2026-06-19", // within the default policy window
  acc: anAccumulator(),
  alreadyAdjudicated: false,
  ...overrides,
});
