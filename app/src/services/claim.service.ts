// app/src/services/claim.service.ts — orchestration: submit claim -> adjudicate -> persist.
//
// A SERVICE holds business logic / workflows; it depends on REPOSITORIES (which own the Db and
// encapsulate all data access), never on the raw connection. Layering: service → repositories → db.
// The one-transaction-per-claim boundary is a `withTransaction` runner injected as a dep, so the
// raw Db never leaks into the service.

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

export type ClaimServiceDeps = {
  claims: ClaimRepository;
  adjudications: AdjudicationRepository;
  accumulators: AccumulatorRepository;
  coverageRules: CoverageRuleRepository;
  policies: PolicyRepository;
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

export function createClaimService(deps: ClaimServiceDeps) {
  function adjudicateClaim(input: AdjudicateClaimInput): AdjudicateClaimResult {
    return deps.withTransaction(() => {
      const policy = deps.policies.findActiveForMember(
        input.memberId,
        input.serviceDate,
      );
      if (!policy) {
        throw new Error(
          `no active policy for member ${input.memberId} on ${input.serviceDate}`,
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

      // One snapshot at claim start; deltas applied to this working copy between lines so a later
      // line sees an earlier line's deductible/OOP/limit draw (determinism — cycle 20).
      const acc = deps.accumulators.snapshot(input.memberId, planYear);
      const touched = {
        deductible: false,
        oop: false,
        limits: new Set<string>(),
      };
      const outcomes: LineOutcome[] = [];

      for (const li of input.lineItems) {
        const fingerprint = `${input.memberId}|${li.serviceCode}|${input.serviceDate}|${li.billedCents}`;
        const line = deps.claims.insertLine(claimId, {
          serviceCode: li.serviceCode,
          billedCents: li.billedCents,
          units: li.units,
          priorAuthPresent: li.priorAuthPresent,
          fingerprint,
        });

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
          rule: ruleByService.get(li.serviceCode),
          serviceDate: input.serviceDate,
          acc: {
            deductibleMetCents: acc.deductibleMetCents,
            oopMetCents: acc.oopMetCents,
            limitUsed: acc.limitUsedByService[li.serviceCode] ?? 0,
          },
          alreadyAdjudicated: false,
        });

        deps.adjudications.append({
          lineItemId: line.id,
          planYear,
          seq: 1, // first decision for this line; a dispute re-adjudication appends a higher seq
          // adjudicateLine only ever decides APPROVED | DENIED (never PENDING/NEEDS_REVIEW)
          status: result.status as "APPROVED" | "DENIED",
          billedCents: line.billedCents,
          payableCents: result.payableCents,
          memberResponsibilityCents: result.memberResponsibilityCents,
          reasons: result.reasons,
          explanation: result.explanation,
          deltas: result.deltas,
        });
        deps.claims.setLineStatus(line.id, result.status);

        if (result.deltas.deductibleIncCents > 0) {
          acc.deductibleMetCents += result.deltas.deductibleIncCents;
          touched.deductible = true;
        }
        if (result.deltas.oopIncCents > 0) {
          acc.oopMetCents += result.deltas.oopIncCents;
          touched.oop = true;
        }
        if (result.deltas.limitInc > 0) {
          acc.limitUsedByService[li.serviceCode] =
            (acc.limitUsedByService[li.serviceCode] ?? 0) +
            result.deltas.limitInc;
          touched.limits.add(li.serviceCode);
        }

        outcomes.push({ status: result.status, reasons: result.reasons });
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
      deps.claims.setClaimStatus(claimId, status);
      return { claimId, status };
    });
  }

  return { ...deps, adjudicateClaim };
}

export type ClaimService = ReturnType<typeof createClaimService>;
