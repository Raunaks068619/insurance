// app/src/services/dispute.service.ts — orchestration: open dispute -> re-adjudicate, preserve original.
//
// A SERVICE holds business logic / workflows; it depends on REPOSITORIES (which own the Db), never on
// the raw connection. Layering: service → repositories → db.
//
// Cycle 27 — open() re-adjudicates a disputed line against current rules + corrected facts, APPENDS a
// new immutable decision at a higher seq, and PRESERVES the original. The accumulator net-out (35),
// transition logging (31), and the full guard set (36) arrive in their own cycles.

import { adjudicateLine } from "../domain/adjudication/adjudicator";
import type { ReasonCode } from "../domain/reason-codes";
import type { AccumulatorRepository } from "../repositories/accumulator.repository";
import type { AdjudicationRepository } from "../repositories/adjudication.repository";
import type { ClaimRepository } from "../repositories/claim.repository";
import type { CoverageRuleRepository } from "../repositories/coverage-rule.repository";
import type {
  CorrectedFacts,
  DisputeOutcome,
  DisputeRepository,
} from "../repositories/dispute.repository";
import type { PolicyRepository } from "../repositories/policy.repository";

export type DisputeServiceDeps = {
  claims: ClaimRepository;
  adjudications: AdjudicationRepository;
  accumulators: AccumulatorRepository;
  coverageRules: CoverageRuleRepository;
  policies: PolicyRepository;
  disputes: DisputeRepository;
  withTransaction: <T>(fn: () => T) => T;
};

export type OpenDisputeInput = {
  lineItemId: string;
  reason: string;
  corrected?: CorrectedFacts | undefined;
};

export type OpenDisputeResult = {
  disputeId: string;
  outcome: DisputeOutcome;
  originalAdjudicationId: string;
  resolvedAdjudicationId: string;
};

type Decision = {
  status: "APPROVED" | "DENIED";
  payableCents: number;
  reasons: ReasonCode[];
};

// Diff the new decision against the original (decision #16 outcome taxonomy).
function diffOutcome(original: Decision, next: Decision): DisputeOutcome {
  if (original.status === "DENIED" && next.status === "APPROVED") {
    return next.reasons.includes("LIMIT_EXCEEDED")
      ? "PARTIALLY_OVERTURNED"
      : "OVERTURNED";
  }
  const unchanged =
    original.status === next.status &&
    original.payableCents === next.payableCents &&
    JSON.stringify(original.reasons) === JSON.stringify(next.reasons);
  return unchanged ? "UPHELD" : "MODIFIED";
}

export function createDisputeService(deps: DisputeServiceDeps) {
  function open(input: OpenDisputeInput): OpenDisputeResult {
    return deps.withTransaction(() => {
      const line = deps.claims.findLineById(input.lineItemId);
      if (!line) throw new Error(`line item not found: ${input.lineItemId}`);
      const original = deps.adjudications.currentForLine(input.lineItemId);
      if (!original)
        throw new Error(
          `no adjudication to dispute for line ${input.lineItemId}`,
        );

      const claim = deps.claims.findClaimById(line.claimId);
      if (!claim) throw new Error(`claim not found: ${line.claimId}`);
      const policy = deps.policies.findActiveForMember(
        claim.memberId,
        claim.serviceDate,
      );
      if (!policy) {
        throw new Error(
          `no active policy for member ${claim.memberId} on ${claim.serviceDate}`,
        );
      }
      const planYear = String(policy.planYear);
      const ruleByService = new Map(
        deps.coverageRules
          .findByPolicy(policy.id)
          .map((r) => [r.serviceCode, r]),
      );

      // Overlay the corrected facts (the only amendable line fields) on the disputed line.
      const corrected = input.corrected ?? {};
      const effServiceCode = corrected.serviceCode ?? line.serviceCode;
      const effBilledCents = corrected.billedCents ?? line.billedCents;
      const effUnits = corrected.units ?? line.units;
      const effPriorAuth = corrected.priorAuthPresent ?? line.priorAuthPresent;

      // Re-adjudicate against current rules + corrected facts. The net-out of the original deltas is
      // a no-op when the disputed decision contributed nothing (e.g. a denial); it is exercised
      // rigorously at cycle 35, so a plain snapshot is sufficient here.
      const acc = deps.accumulators.snapshot(claim.memberId, planYear);
      const result = adjudicateLine({
        line: {
          id: line.id,
          claimId: line.claimId,
          serviceCode: effServiceCode,
          billedCents: effBilledCents,
          units: effUnits,
          priorAuthPresent: effPriorAuth,
          status: "PENDING",
          fingerprint: line.fingerprint,
        },
        policy,
        rule: ruleByService.get(effServiceCode),
        serviceDate: claim.serviceDate,
        acc: {
          deductibleMetCents: acc.deductibleMetCents,
          oopMetCents: acc.oopMetCents,
          limitUsed: acc.limitUsedByService[effServiceCode] ?? 0,
        },
        alreadyAdjudicated: false,
      });

      // Append the NEW decision at a higher seq — the original row is never touched (append-only).
      const newStatus = result.status as "APPROVED" | "DENIED";
      const resolvedAdjudicationId = deps.adjudications.append({
        lineItemId: input.lineItemId,
        planYear,
        seq: original.seq + 1,
        status: newStatus,
        billedCents: effBilledCents,
        payableCents: result.payableCents,
        memberResponsibilityCents: result.memberResponsibilityCents,
        reasons: result.reasons,
        explanation: result.explanation,
        deltas: result.deltas,
      });
      deps.claims.setLineStatus(input.lineItemId, newStatus);

      const outcome = diffOutcome(
        {
          status: original.status,
          payableCents: original.payableCents,
          reasons: original.reasons,
        },
        {
          status: newStatus,
          payableCents: result.payableCents,
          reasons: result.reasons,
        },
      );

      const disputeId = deps.disputes.insertResolved({
        lineItemId: input.lineItemId,
        originalAdjudicationId: original.id,
        resolvedAdjudicationId,
        reason: input.reason,
        corrected: input.corrected,
        outcome,
      });

      return {
        disputeId,
        outcome,
        originalAdjudicationId: original.id,
        resolvedAdjudicationId,
      };
    });
  }

  return { ...deps, open };
}

export type DisputeService = ReturnType<typeof createDisputeService>;
