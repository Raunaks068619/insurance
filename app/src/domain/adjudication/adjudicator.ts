// app/src/domain/adjudication/adjudicator.ts — the pure adjudication core.
// adjudicateLine(input) -> decision + accumulator deltas. No I/O: it reads a snapshot
// and returns the deltas for the caller to persist, which is what makes it deterministic
// and unit-testable with plain objects (no DB for the pure cycles).

import type { LineItem, LineItemStatus } from "../entities/line-item";
import type { Policy } from "../entities/policy";
import { formatUsd } from "../money/cents";
import { ReasonCode } from "../reason-codes";
import type { CoverageRule } from "../rules/coverage-rule";

export type AccumulatorSnapshot = {
  deductibleMetCents: number;
  oopMetCents: number;
  limitUsed: number; // cents for a dollar limit, a count for a visit limit
};

export type AdjudicateLineInput = {
  line: LineItem;
  policy: Policy;
  rule: CoverageRule | undefined; // matched by serviceCode; undefined => NO_COVERAGE
  serviceDate: string; // claim-level ISO date (policy-active check)
  acc: AccumulatorSnapshot; // read-only snapshot taken at claim start
  alreadyAdjudicated: boolean; // true => DUPLICATE_LINE_ITEM
};

export type AdjudicateLineResult = {
  status: LineItemStatus; // APPROVED | DENIED (NEEDS_REVIEW only via dispute)
  payableCents: number; // plan pays
  memberResponsibilityCents: number; // member owes
  reasons: ReasonCode[]; // dominant code first, then any breakdown
  explanation: string; // EOB sentence citing the rule + the numbers used
  deltas: { deductibleIncCents: number; oopIncCents: number; limitInc: number };
};

export function adjudicateLine(input: AdjudicateLineInput): AdjudicateLineResult {
  const { rule, line } = input;

  // Cycle 2 — gate: no rule matched this service_code → NO_COVERAGE. Plan pays
  // nothing, no accumulator is touched. A denial is a processed decision, not an error.
  if (!rule) {
    return {
      status: "DENIED",
      payableCents: 0,
      memberResponsibilityCents: 0,
      reasons: [ReasonCode.NO_COVERAGE],
      explanation: `No coverage: no benefit rule applies to ${line.serviceCode}, so the plan pays ${formatUsd(0)}.`,
      deltas: { deductibleIncCents: 0, oopIncCents: 0, limitInc: 0 },
    };
  }

  // Cycle 1 — the full-coverage happy path: plan pays 100%, member owes nothing,
  // deductible/OOP/limit untouched. Every other branch (gates, copay, coinsurance,
  // limits, OOP) arrives in a later cycle, each driven by its own failing test.
  if (rule && rule.covered && !rule.excluded && rule.costShare.type === "full_coverage") {
    return {
      status: "APPROVED",
      payableCents: line.billedCents,
      memberResponsibilityCents: 0,
      reasons: [ReasonCode.APPROVED],
      explanation: `Full coverage: the plan pays 100% (${formatUsd(line.billedCents)}); you owe ${formatUsd(0)}.`,
      deltas: { deductibleIncCents: 0, oopIncCents: 0, limitInc: 0 },
    };
  }

  throw new Error("adjudicateLine: only full_coverage is implemented (TDD cycle 1)");
}
