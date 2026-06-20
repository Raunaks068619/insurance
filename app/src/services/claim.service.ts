// app/src/services/claim.service.ts — orchestration: submit claim -> adjudicate -> persist.
//
// A SERVICE holds business logic / workflows; it depends on REPOSITORIES (which own the Db and
// encapsulate all data access), never on the raw connection. Layering: service → repositories → db.
// Every status change routes through the injected setStatus() chokepoint (status column + transition
// log in one write). The one-transaction-per-claim boundary is an injected withTransaction runner.

import { adjudicateLine } from "../domain/adjudication/adjudicator";
import type { ClaimStatus } from "../domain/entities/claim";
import {
  type LineOutcome,
  aggregateClaimStatus,
} from "../domain/state-machines/claim-state";
import type { AccumulatorRepository } from "../repositories/accumulator.repository";
import type { AdjudicationRepository } from "../repositories/adjudication.repository";
import type { ClaimRepository } from "../repositories/claim.repository";
import type { CoverageRuleRepository } from "../repositories/coverage-rule.repository";
import type { PolicyRepository } from "../repositories/policy.repository";
import type { SetStatus } from "./set-status";

export type ClaimServiceDeps = {
  claims: ClaimRepository;
  adjudications: AdjudicationRepository;
  accumulators: AccumulatorRepository;
  coverageRules: CoverageRuleRepository;
  policies: PolicyRepository;
  setStatus: SetStatus;
  withTransaction: <T>(fn: () => T) => T;
};

export type AdjudicateClaimInput = {
  memberId: string;
  serviceDate: string;
  provider?: string;
  diagnosisCode?: string;
  lineItems: {
    serviceCode: string;
    billedCents: number;
    units?: number;
    priorAuthPresent?: boolean;
  }[];
};

export type AdjudicateClaimResult = { claimId: string; status: ClaimStatus };

// An intake identity failure (4xx) — distinct from an adjudication decision (HTTP 200). Thrown when
// a claim cannot be resolved to a member's policy at all; the controller maps it to a 400 reject.
export class ClaimIntakeError extends Error {
  readonly field: string;
  readonly code: string;
  constructor(field: string, code: string, message: string) {
    super(message);
    this.name = "ClaimIntakeError";
    this.field = field;
    this.code = code;
  }
}

export function createClaimService(deps: ClaimServiceDeps) {
  function adjudicateClaim(input: AdjudicateClaimInput): AdjudicateClaimResult {
    return deps.withTransaction(() => {
      // Resolve the member's policy WITHOUT a date filter: an out-of-window date is a
      // POLICY_NOT_ACTIVE decision (the adjudicator's first gate), not an intake reject. Only a
      // member with no policy on file is unresolvable.
      const policy = deps.policies.findByMember(input.memberId);
      if (!policy) {
        throw new ClaimIntakeError(
          "memberId",
          "MEMBER_NOT_FOUND",
          `no policy on file for member ${input.memberId}`,
        );
      }
      const planYear = String(policy.planYear);
      const ruleByService = new Map(
        deps.coverageRules
          .findByPolicy(policy.id)
          .map((r) => [r.serviceCode, r]),
      );

      const claimId = deps.claims.insertClaim({
        memberId: input.memberId,
        policyId: policy.id,
        serviceDate: input.serviceDate,
        provider: input.provider ?? null,
        diagnosisCode: input.diagnosisCode ?? null,
      });
      deps.setStatus({
        claimId,
        target: { type: "CLAIM", status: "SUBMITTED" },
        fromStatus: null,
        actor: "SYSTEM",
        reason: "SUBMIT",
      });

      // Phase 1 — persist + submit every line (PENDING).
      const submitted = input.lineItems.map((li) => {
        const fingerprint = `${input.memberId}|${li.serviceCode}|${input.serviceDate}|${li.billedCents}`;
        const line = deps.claims.insertLine(claimId, {
          serviceCode: li.serviceCode,
          billedCents: li.billedCents,
          units: li.units,
          priorAuthPresent: li.priorAuthPresent,
          fingerprint,
        });
        deps.setStatus({
          claimId,
          target: { type: "LINE_ITEM", id: line.id, status: "PENDING" },
          fromStatus: null,
          actor: "SYSTEM",
          reason: "SUBMIT",
        });
        return { line, fingerprint };
      });

      // Phase 2 — adjudicate each line in order. One snapshot at claim start; deltas are applied to
      // this working copy between lines so a later line sees an earlier line's draw (determinism).
      const acc = deps.accumulators.snapshot(input.memberId, planYear);
      const touched = {
        deductible: false,
        oop: false,
        limits: new Set<string>(),
      };
      const outcomes: LineOutcome[] = [];

      for (const { line, fingerprint } of submitted) {
        const result = adjudicateLine({
          line: {
            id: line.id,
            claimId,
            serviceCode: line.serviceCode,
            billedCents: line.billedCents,
            units: line.units,
            priorAuthPresent: line.priorAuthPresent,
            status: "PENDING",
            fingerprint,
          },
          policy,
          rule: ruleByService.get(line.serviceCode),
          serviceDate: input.serviceDate,
          acc: {
            deductibleMetCents: acc.deductibleMetCents,
            oopMetCents: acc.oopMetCents,
            limitUsed: acc.limitUsedByService[line.serviceCode] ?? 0,
          },
          // Duplicate when another already-decided line shares this fingerprint — across a
          // prior claim or an earlier line in this same batch (see existsForFingerprint).
          alreadyAdjudicated: deps.adjudications.existsForFingerprint(
            fingerprint,
            line.id,
          ),
        });

        // adjudicateLine only ever decides APPROVED | DENIED (never PENDING/NEEDS_REVIEW)
        const newStatus = result.status as "APPROVED" | "DENIED";
        deps.adjudications.append({
          lineItemId: line.id,
          planYear,
          seq: 1, // first decision for this line; a dispute re-adjudication appends a higher seq
          status: newStatus,
          billedCents: line.billedCents,
          payableCents: result.payableCents,
          memberResponsibilityCents: result.memberResponsibilityCents,
          reasons: result.reasons,
          explanation: result.explanation,
          deltas: result.deltas,
        });
        deps.setStatus({
          claimId,
          target: { type: "LINE_ITEM", id: line.id, status: newStatus },
          fromStatus: "PENDING",
          actor: "SYSTEM",
          reason: "ADJUDICATED",
        });

        if (result.deltas.deductibleIncCents > 0) {
          acc.deductibleMetCents += result.deltas.deductibleIncCents;
          touched.deductible = true;
        }
        if (result.deltas.oopIncCents > 0) {
          acc.oopMetCents += result.deltas.oopIncCents;
          touched.oop = true;
        }
        if (result.deltas.limitInc > 0) {
          acc.limitUsedByService[line.serviceCode] =
            (acc.limitUsedByService[line.serviceCode] ?? 0) +
            result.deltas.limitInc;
          touched.limits.add(line.serviceCode);
        }

        outcomes.push({ status: newStatus, reasons: result.reasons });
      }

      // persist only the dimensions this claim actually touched (rows are created lazily)
      if (touched.deductible) {
        deps.accumulators.upsert({
          memberId: input.memberId,
          planYear,
          dimension: "DEDUCTIBLE",
          unit: "CENTS",
          usedCents: acc.deductibleMetCents,
          usedCount: 0,
        });
      }
      if (touched.oop) {
        deps.accumulators.upsert({
          memberId: input.memberId,
          planYear,
          dimension: "OOP",
          unit: "CENTS",
          usedCents: acc.oopMetCents,
          usedCount: 0,
        });
      }
      for (const service of touched.limits) {
        const isVisits = ruleByService.get(service)?.limit.unit === "visits";
        const used = acc.limitUsedByService[service] ?? 0;
        deps.accumulators.upsert({
          memberId: input.memberId,
          planYear,
          dimension: `LIMIT:${service}`,
          unit: isVisits ? "COUNT" : "CENTS",
          usedCents: isVisits ? 0 : used,
          usedCount: isVisits ? used : 0,
        });
      }

      const status = aggregateClaimStatus(outcomes);
      deps.setStatus({
        claimId,
        target: { type: "CLAIM", status },
        fromStatus: "SUBMITTED",
        actor: "SYSTEM",
        reason: "AGGREGATED",
      });
      return { claimId, status };
    });
  }

  return { ...deps, adjudicateClaim };
}

export type ClaimService = ReturnType<typeof createClaimService>;
