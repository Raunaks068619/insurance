// app/src/index.ts — production bootstrap: open the file-backed DB, apply schema,
// wire the 7 repositories + 3 services (one composition root), build the Fastify app, listen.
//
// Mirrors the test composition in app/tests/db-helpers.ts, but over a file path instead of
// :memory:. Both write services share ONE Db handle with the read service so reads see what
// writes wrote, and every status change routes through the single setStatus chokepoint.

import { buildApp } from "./app";
import { createDb } from "./db/connection";
import { applySchema } from "./db/migrate";
import { seed } from "./db/seed";
import { createAccumulatorRepository } from "./repositories/accumulator.repository";
import { createAdjudicationRepository } from "./repositories/adjudication.repository";
import { createClaimRepository } from "./repositories/claim.repository";
import { createCoverageRuleRepository } from "./repositories/coverage-rule.repository";
import { createDisputeRepository } from "./repositories/dispute.repository";
import { createPolicyRepository } from "./repositories/policy.repository";
import { createStatusTransitionRepository } from "./repositories/status-transition.repository";
import { createClaimReadService } from "./services/claim-read.service";
import { createClaimService } from "./services/claim.service";
import { createDisputeService } from "./services/dispute.service";
import { createSetStatus } from "./services/set-status";

const DB_PATH = process.env.DB_PATH ?? "./claims.db";
const PORT = Number(process.env.PORT ?? 3000);

const { db, sqlite } = createDb(DB_PATH);
applySchema(sqlite);
seed(db); // insert the reference member + policy + rules (idempotent)

const claims = createClaimRepository(db);
const policies = createPolicyRepository(db);
const coverageRules = createCoverageRuleRepository(db);
const accumulators = createAccumulatorRepository(db);
const adjudications = createAdjudicationRepository(db);
const disputes = createDisputeRepository(db);
const statusTransitions = createStatusTransitionRepository(db);

const setStatus = createSetStatus({ claims, statusTransitions });
const withTransaction = <T>(fn: () => T): T => sqlite.transaction(fn)();

const claimService = createClaimService({
  claims,
  adjudications,
  accumulators,
  coverageRules,
  policies,
  setStatus,
  withTransaction,
});

const claimReadService = createClaimReadService({
  claims,
  adjudications,
  statusTransitions,
});

const disputeService = createDisputeService({
  claims,
  adjudications,
  accumulators,
  coverageRules,
  policies,
  disputes,
  setStatus,
  withTransaction,
});

const app = buildApp({ claimService, claimReadService, disputeService });

app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`claims server listening on ${address}`);
});
