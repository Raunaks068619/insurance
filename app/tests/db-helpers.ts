// app/tests/db-helpers.ts — DB test infrastructure for the writeback / transition / dispute cycles.
//
// freshDb() gives each test an isolated in-memory database with the schema applied.
// seedWorld() inserts the reference data (member + active policy + coverage rules) a claim needs.
// makeClaimService() is the composition root: it wires the repositories + service over one Db.

import { type Db, type DbHandle, createDb } from "../src/db/connection";
import { applySchema } from "../src/db/migrate";
import { coverageRules, members, policies } from "../src/db/schema";
import type { CoverageRule } from "../src/domain/types";
import { createAccumulatorRepository } from "../src/repositories/accumulator.repository";
import { createAdjudicationRepository } from "../src/repositories/adjudication.repository";
import { createClaimRepository } from "../src/repositories/claim.repository";
import { createCoverageRuleRepository } from "../src/repositories/coverage-rule.repository";
import { createDisputeRepository } from "../src/repositories/dispute.repository";
import { createPolicyRepository } from "../src/repositories/policy.repository";
import { createStatusTransitionRepository } from "../src/repositories/status-transition.repository";
import {
  type ClaimServiceDeps,
  createClaimService,
} from "../src/services/claim.service";
import {
  type DisputeServiceDeps,
  createDisputeService,
} from "../src/services/dispute.service";
import { createSetStatus } from "../src/services/set-status";

export function freshDb() {
  const handle = createDb(":memory:");
  applySchema(handle.sqlite);
  return handle;
}

export function makeClaimService(
  handle: DbHandle,
  overrides: Partial<ClaimServiceDeps> = {},
) {
  const { db, sqlite } = handle;
  const claims = createClaimRepository(db);
  const statusTransitions = createStatusTransitionRepository(db);
  return createClaimService({
    claims,
    adjudications: createAdjudicationRepository(db),
    accumulators: createAccumulatorRepository(db),
    coverageRules: createCoverageRuleRepository(db),
    policies: createPolicyRepository(db),
    setStatus: createSetStatus({ claims, statusTransitions }),
    // one transaction per claim — better-sqlite3 wraps every statement on this connection
    withTransaction: <T>(fn: () => T): T => sqlite.transaction(fn)(),
    ...overrides,
  });
}

export function makeDisputeService(
  handle: DbHandle,
  overrides: Partial<DisputeServiceDeps> = {},
) {
  const { db, sqlite } = handle;
  const claims = createClaimRepository(db);
  const statusTransitions = createStatusTransitionRepository(db);
  return createDisputeService({
    claims,
    adjudications: createAdjudicationRepository(db),
    accumulators: createAccumulatorRepository(db),
    coverageRules: createCoverageRuleRepository(db),
    policies: createPolicyRepository(db),
    disputes: createDisputeRepository(db),
    setStatus: createSetStatus({ claims, statusTransitions }),
    withTransaction: <T>(fn: () => T): T => sqlite.transaction(fn)(),
    ...overrides,
  });
}

export function makeSetStatus(handle: DbHandle) {
  const { db } = handle;
  return createSetStatus({
    claims: createClaimRepository(db),
    statusTransitions: createStatusTransitionRepository(db),
  });
}

type SeedRule = Partial<CoverageRule> & { serviceCode: string };

// Insert a member + an active 2026 policy + coverage rules. Returns the ids a claim needs.
export function seedWorld(
  db: Db,
  opts: { deductibleCents?: number; oopMaxCents?: number; rules: SeedRule[] },
) {
  const memberId = "mem_seed_1";
  const policyId = "pol_seed_1";
  const planYear = "2026";

  db.insert(members)
    .values({ id: memberId, name: "Jane Doe", dob: "1990-05-01" })
    .run();
  db.insert(policies)
    .values({
      id: policyId,
      memberId,
      planYear,
      effectiveDate: "2026-01-01",
      terminationDate: "2026-12-31",
      deductibleCents: opts.deductibleCents ?? 50_000,
      oopMaxCents: opts.oopMaxCents ?? 300_000,
    })
    .run();

  opts.rules.forEach((r, i) => {
    const costShare = r.costShare ?? { type: "full_coverage" };
    const limit = r.limit ?? { unit: "none" };
    db.insert(coverageRules)
      .values({
        id: `cr_seed_${i}`,
        policyId,
        serviceCode: r.serviceCode,
        covered: r.covered ?? true,
        excluded: r.excluded ?? false,
        costShareType: costShare.type,
        copayCents: costShare.type === "copay" ? costShare.copayCents : null,
        coinsuranceRate:
          costShare.type === "coinsurance" ? costShare.rate : null,
        appliesDeductible: r.appliesDeductible ?? false,
        limitUnit: limit.unit,
        limitAmountCents: limit.unit === "dollars" ? limit.amountCents : null,
        limitCount: limit.unit === "visits" ? limit.count : null,
        requiresPriorAuth: r.requiresPriorAuth ?? false,
      })
      .run();
  });

  return { memberId, policyId, planYear };
}
