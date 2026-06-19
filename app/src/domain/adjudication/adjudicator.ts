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
  const { rule, line, policy, serviceDate, alreadyAdjudicated } = input;

  // Every gate denial shares one shape: plan pays nothing, member owes nothing here
  // (a non-covered service is billed to the member directly, not as cost-share), and
  // no accumulator is touched. A denial is a processed decision, never an error.
  const deny = (reason: ReasonCode, explanation: string): AdjudicateLineResult => ({
    status: "DENIED",
    payableCents: 0,
    memberResponsibilityCents: 0,
    reasons: [reason],
    explanation,
    deltas: { deductibleIncCents: 0, oopIncCents: 0, limitInc: 0 },
  });

  // GATES — fire in pipeline order; the first failing gate denies the line.

  // Cycle 7 — duplicate fingerprint already adjudicated.
  if (alreadyAdjudicated) {
    return deny(
      ReasonCode.DUPLICATE_LINE_ITEM,
      `Duplicate line: ${line.serviceCode} was already adjudicated; the plan pays ${formatUsd(0)}.`,
    );
  }

  // Cycle 5 — service date outside the policy's active window. ISO dates compare lexically.
  if (serviceDate < policy.effectiveDate || serviceDate > policy.terminationDate) {
    return deny(
      ReasonCode.POLICY_NOT_ACTIVE,
      `Policy not active: ${serviceDate} is outside the coverage window (${policy.effectiveDate}–${policy.terminationDate}); the plan pays ${formatUsd(0)}.`,
    );
  }

  // Cycle 2 — no benefit rule matched this service_code.
  if (!rule) {
    return deny(
      ReasonCode.NO_COVERAGE,
      `No coverage: no benefit rule applies to ${line.serviceCode}, so the plan pays ${formatUsd(0)}.`,
    );
  }

  // Cycle 3 — the rule explicitly excludes this service.
  if (rule.excluded) {
    return deny(
      ReasonCode.EXCLUDED,
      `Excluded benefit: ${line.serviceCode} is excluded from the plan, so the plan pays ${formatUsd(0)}.`,
    );
  }

  // Cycle 4 — the rule exists but the service is not a covered benefit.
  if (!rule.covered) {
    return deny(
      ReasonCode.NO_COVERAGE,
      `No coverage: ${line.serviceCode} is not a covered benefit, so the plan pays ${formatUsd(0)}.`,
    );
  }

  // Cycle 6 — prior auth required but not present → clean deny.
  if (rule.requiresPriorAuth && !line.priorAuthPresent) {
    return deny(
      ReasonCode.PRIOR_AUTH_REQUIRED,
      `Prior authorization required: ${line.serviceCode} needs prior auth, which was not present; the plan pays ${formatUsd(0)}.`,
    );
  }

  // Cycle 1 — the full-coverage happy path: plan pays 100%, member owes nothing,
  // deductible/OOP/limit untouched. Cost-share math (copay, coinsurance, limits,
  // OOP) arrives in later cycles, each driven by its own failing test.
  if (rule.costShare.type === "full_coverage") {
    return {
      status: "APPROVED",
      payableCents: line.billedCents,
      memberResponsibilityCents: 0,
      reasons: [ReasonCode.APPROVED],
      explanation: `Full coverage: the plan pays 100% (${formatUsd(line.billedCents)}); you owe ${formatUsd(0)}.`,
      deltas: { deductibleIncCents: 0, oopIncCents: 0, limitInc: 0 },
    };
  }

  throw new Error("adjudicateLine: cost-share math (copay/coinsurance) not yet implemented (TDD cycles 8+)");
}
