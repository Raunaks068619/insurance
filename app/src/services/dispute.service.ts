// app/src/services/dispute.service.ts — orchestration: open dispute -> re-adjudicate, preserve original.
//
// A SERVICE holds business logic / workflows; it depends on REPOSITORIES (which own the Db), never on
// the raw connection. Layering: service → repositories → db. Every status change routes through the
// injected setStatus() chokepoint.
//
// A dispute is synchronous (open → re-adjudicate → resolve, one transaction). It re-adjudicates the
// disputed line against CURRENT rules + corrected facts and a working snapshot of
// `current accumulator − this line's own original deltas` (net-out — decision #16), APPENDS a new
// immutable decision (the original is preserved), and resolves to a 4-value outcome. Guards: a
// missing line → NOT_FOUND (404); a non-terminal line → CONFLICT (409).

import { adjudicateLine } from "../domain/adjudication/adjudicator";
import type { ReasonCode } from "../domain/reason-codes";
import { aggregateClaimStatus } from "../domain/state-machines/claim-state";
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
import type { SetStatus } from "./set-status";

export type DisputeErrorCode = "NOT_FOUND" | "CONFLICT";

// A dispute identity/state failure (4xx) — distinct from an adjudication decision (HTTP 200).
export class DisputeError extends Error {
  readonly code: DisputeErrorCode;
  constructor(code: DisputeErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "DisputeError";
  }
}

export type DisputeServiceDeps = {
  claims: ClaimRepository;
  adjudications: AdjudicationRepository;
  accumulators: AccumulatorRepository;
  coverageRules: CoverageRuleRepository;
  policies: PolicyRepository;
  disputes: DisputeRepository;
  setStatus: SetStatus;
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
      if (!line) {
        throw new DisputeError(
          "NOT_FOUND",
          `line item not found: ${input.lineItemId}`,
        );
      }
      // Only a terminal line is disputable (decision #16); PENDING / NEEDS_REVIEW → 409.
      if (line.status !== "APPROVED" && line.status !== "DENIED") {
        throw new DisputeError(
          "CONFLICT",
          `line ${input.lineItemId} is not in a terminal state (${line.status})`,
        );
      }
      const original = deps.adjudications.currentForLine(input.lineItemId);
      if (!original) {
        throw new DisputeError(
          "NOT_FOUND",
          `no adjudication to dispute for line ${input.lineItemId}`,
        );
      }

      const claim = deps.claims.findClaimById(line.claimId);
      if (!claim)
        throw new DisputeError("NOT_FOUND", `claim not found: ${line.claimId}`);
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

      // Reopen: the terminal line moves to NEEDS_REVIEW, initiated by the MEMBER.
      deps.setStatus({
        claimId: claim.id,
        target: { type: "LINE_ITEM", id: line.id, status: "NEEDS_REVIEW" },
        fromStatus: original.status,
        actor: "MEMBER",
        reason: "DISPUTE_REOPEN",
      });

      // Overlay the corrected facts (the only amendable line fields).
      const corrected = input.corrected ?? {};
      const origService = line.serviceCode;
      const effServiceCode = corrected.serviceCode ?? line.serviceCode;
      const effBilledCents = corrected.billedCents ?? line.billedCents;
      const effUnits = corrected.units ?? line.units;
      const effPriorAuth = corrected.priorAuthPresent ?? line.priorAuthPresent;

      // Net-out: re-adjudicate against `current accumulator − this line's own original deltas`, so
      // the disputed line contributes exactly once (at its newest decision). Invariant: each
      // dimension = Σ of every line's latest deltas — the deductible never double-counts.
      const acc = deps.accumulators.snapshot(claim.memberId, planYear);
      const od = original.deltas;
      const nettedDeductible = acc.deductibleMetCents - od.deductibleIncCents;
      const nettedOop = acc.oopMetCents - od.oopIncCents;
      const nettedLimitOrig =
        (acc.limitUsedByService[origService] ?? 0) - od.limitInc;
      const nettedLimitEff =
        effServiceCode === origService
          ? nettedLimitOrig
          : (acc.limitUsedByService[effServiceCode] ?? 0);

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
          deductibleMetCents: nettedDeductible,
          oopMetCents: nettedOop,
          limitUsed: nettedLimitEff,
        },
        alreadyAdjudicated: false,
      });
      const nd = result.deltas;

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
        deltas: nd,
      });
      // Auto re-adjudication clears NEEDS_REVIEW back to a terminal line state.
      deps.setStatus({
        claimId: claim.id,
        target: { type: "LINE_ITEM", id: line.id, status: newStatus },
        fromStatus: "NEEDS_REVIEW",
        actor: "SYSTEM",
        reason: "ADJUDICATED",
      });

      // Write back the net-out: final = (current − original deltas) + new deltas, per touched dimension.
      const limitUnitOf = (svc: string): "CENTS" | "COUNT" =>
        ruleByService.get(svc)?.limit.unit === "visits" ? "COUNT" : "CENTS";
      if (od.deductibleIncCents > 0 || nd.deductibleIncCents > 0) {
        deps.accumulators.upsert({
          memberId: claim.memberId,
          planYear,
          dimension: "DEDUCTIBLE",
          unit: "CENTS",
          usedCents: nettedDeductible + nd.deductibleIncCents,
          usedCount: 0,
        });
      }
      if (od.oopIncCents > 0 || nd.oopIncCents > 0) {
        deps.accumulators.upsert({
          memberId: claim.memberId,
          planYear,
          dimension: "OOP",
          unit: "CENTS",
          usedCents: nettedOop + nd.oopIncCents,
          usedCount: 0,
        });
      }
      const upsertLimit = (svc: string, used: number) => {
        const unit = limitUnitOf(svc);
        deps.accumulators.upsert({
          memberId: claim.memberId,
          planYear,
          dimension: `LIMIT:${svc}`,
          unit,
          usedCents: unit === "CENTS" ? used : 0,
          usedCount: unit === "COUNT" ? used : 0,
        });
      };
      if (effServiceCode === origService) {
        if (od.limitInc > 0 || nd.limitInc > 0)
          upsertLimit(origService, nettedLimitOrig + nd.limitInc);
      } else {
        if (od.limitInc > 0) upsertLimit(origService, nettedLimitOrig); // removed from the old service
        if (nd.limitInc > 0)
          upsertLimit(effServiceCode, nettedLimitEff + nd.limitInc);
      }

      // Re-aggregate the claim from every line's current decision.
      const claimStatus = aggregateClaimStatus(
        deps.adjudications.currentOutcomesByClaim(claim.id),
      );
      deps.setStatus({
        claimId: claim.id,
        target: { type: "CLAIM", status: claimStatus },
        fromStatus: claim.status,
        actor: "SYSTEM",
        reason: "AGGREGATED",
      });

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
