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
  const { rule, line, policy, serviceDate, acc, alreadyAdjudicated } = input;

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

  // Cycle 15 — visit limit fully consumed → whole-visit denial (no partial visit).
  if (rule.limit.unit === "visits" && acc.limitUsed >= rule.limit.count) {
    return deny(
      ReasonCode.LIMIT_EXCEEDED,
      `Limit exceeded: ${line.serviceCode} has used all ${rule.limit.count} covered visits this plan year; the plan pays ${formatUsd(0)}.`,
    );
  }

  // Dollar limit fully exhausted (no remaining at all) → denial. A *partial* remaining is
  // handled after cost-share as a straddle (cycle 17), where the line stays APPROVED.
  if (rule.limit.unit === "dollars" && acc.limitUsed >= rule.limit.amountCents) {
    return deny(
      ReasonCode.LIMIT_EXCEEDED,
      `Limit exceeded: ${line.serviceCode} has reached its ${formatUsd(rule.limit.amountCents)} annual limit; the plan pays ${formatUsd(0)}.`,
    );
  }

  // ---- Cost-share (step 7): compute the base member / plan split. Every covered line
  // satisfies `payable + member === billed`. The limit step below may then shift money. ----
  let result: AdjudicateLineResult;

  if (rule.costShare.type === "full_coverage") {
    // Cycle 1 — plan pays 100%, member owes nothing, deductible/OOP untouched.
    result = {
      status: "APPROVED",
      payableCents: line.billedCents,
      memberResponsibilityCents: 0,
      reasons: [ReasonCode.APPROVED],
      explanation: `Full coverage: the plan pays 100% (${formatUsd(line.billedCents)}); you owe ${formatUsd(0)}.`,
      deltas: { deductibleIncCents: 0, oopIncCents: 0, limitInc: 0 },
    };
  } else if (rule.costShare.type === "copay") {
    // Cycle 8–9 — flat copay; waives the deductible but counts to OOP; member ≤ allowed.
    const allowedCents = line.billedCents;
    const memberCents = Math.min(rule.costShare.copayCents, allowedCents);
    const planCents = allowedCents - memberCents;
    result = {
      status: "APPROVED",
      payableCents: planCents,
      memberResponsibilityCents: memberCents,
      reasons: [ReasonCode.APPROVED, ReasonCode.COPAY_APPLIED],
      explanation: `Copay: you pay the ${formatUsd(memberCents)} copay; the plan pays ${formatUsd(planCents)}.`,
      deltas: { deductibleIncCents: 0, oopIncCents: memberCents, limitInc: 0 },
    };
  } else {
    // Cycle 10–13 — coinsurance: the deductible draws first (when applies_deductible), then the
    // member pays `rate` of the remainder. Rounding lives only on the coinsurance share; `plan`
    // is computed last as `allowed − member`, so the shares always sum to allowed (no lost cent).
    const allowedCents = line.billedCents;
    const remainingDeductibleCents = Math.max(0, policy.deductibleCents - acc.deductibleMetCents);
    const dedPortionCents = rule.appliesDeductible
      ? Math.min(remainingDeductibleCents, allowedCents)
      : 0;
    const remainderCents = allowedCents - dedPortionCents;
    const coinsPortionCents = Math.round(rule.costShare.rate * remainderCents); // half-up
    const memberCents = dedPortionCents + coinsPortionCents;
    const planCents = allowedCents - memberCents;

    const reasons: ReasonCode[] = [ReasonCode.APPROVED];
    if (dedPortionCents > 0) reasons.push(ReasonCode.DEDUCTIBLE_APPLIED);
    reasons.push(ReasonCode.COINSURANCE_APPLIED);

    const ratePct = Math.round(rule.costShare.rate * 100);
    const dedNote = dedPortionCents > 0 ? `${formatUsd(dedPortionCents)} toward your deductible plus ` : "";
    result = {
      status: "APPROVED",
      payableCents: planCents,
      memberResponsibilityCents: memberCents,
      reasons,
      explanation: `Coinsurance: you pay ${formatUsd(memberCents)} (${dedNote}${ratePct}% of ${formatUsd(remainderCents)}); the plan pays ${formatUsd(planCents)}.`,
      deltas: { deductibleIncCents: dedPortionCents, oopIncCents: memberCents, limitInc: 0 },
    };
  }

  // ---- Limit application (steps 5b/7b/9): the gates above already denied a fully-exhausted
  // limit, so here there is room. A visit consumes one unit; a dollar limit accrues the plan
  // pay and may straddle the cap (cap plan at the remaining, shift the shortfall to member). ----
  if (rule.limit.unit === "visits") {
    // Cycle 14 — a covered visit consumes one unit of the visit allowance.
    result.deltas.limitInc = 1;
  } else if (rule.limit.unit === "dollars") {
    const remainingCents = rule.limit.amountCents - acc.limitUsed;
    if (result.payableCents > remainingCents) {
      // Cycle 17 — straddle: the plan pay crosses the remaining dollar cap. Cap the plan at
      // the remaining, push the shortfall to the member, note LIMIT_EXCEEDED; line stays
      // APPROVED. The over-limit shortfall is the member's own cost — it does not accrue to OOP.
      const shortfallCents = result.payableCents - remainingCents;
      result.payableCents = remainingCents;
      result.memberResponsibilityCents += shortfallCents;
      result.reasons = [...result.reasons, ReasonCode.LIMIT_EXCEEDED];
      result.deltas.limitInc = remainingCents;
      result.explanation += ` The ${formatUsd(rule.limit.amountCents)} annual limit is reached; ${formatUsd(shortfallCents)} is your responsibility.`;
    } else {
      // Cycle 16 — within the remaining dollar cap: the plan pay accrues to the limit.
      result.deltas.limitInc = result.payableCents;
    }
  }

  // ---- OOP cap (step 8): the member never pays past the out-of-pocket maximum. If this
  // line's OOP-accruing share would cross the cap, refund the excess to the plan and fill the
  // OOP exactly to the max. The over-limit straddle shortfall is not OOP-eligible, so it is
  // never in deltas.oopIncCents and is correctly left out of this check. ----
  const oopRoomCents = policy.oopMaxCents - acc.oopMetCents;
  if (result.deltas.oopIncCents > oopRoomCents) {
    const excessCents = result.deltas.oopIncCents - oopRoomCents;
    result.memberResponsibilityCents -= excessCents; // member pays only up to the cap
    result.payableCents += excessCents; // the plan absorbs the rest
    result.deltas.oopIncCents = oopRoomCents; // OOP fills exactly to the max
    result.reasons = [...result.reasons, ReasonCode.OOP_MAX_REACHED];
    result.explanation += ` Your out-of-pocket maximum is reached, so the plan covers the remaining ${formatUsd(excessCents)}.`;
  }

  return result;
}
