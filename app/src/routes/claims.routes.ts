// app/src/routes/claims.routes.ts — registers the /claims endpoints on a Fastify instance.
// Routes only wire URL+method → controller handler; validation schemas and handlers live elsewhere.

import type { FastifyInstance } from "fastify";
import {
  type ClaimControllerDeps,
  createClaimController,
} from "../controllers/claim.controller";
import {
  type DisputeControllerDeps,
  createDisputeController,
} from "../controllers/dispute.controller";
import { disputeBodySchema } from "../schemas/api/dispute.schema";
import { submitClaimBodySchema } from "../schemas/api/submit-claim.schema";

export function registerClaimRoutes(
  app: FastifyInstance,
  deps: ClaimControllerDeps & DisputeControllerDeps,
): void {
  const claims = createClaimController(deps);
  const disputes = createDisputeController(deps);

  app.post(
    "/claims",
    { schema: { body: submitClaimBodySchema } },
    claims.submit,
  );
  app.get("/claims/:id", claims.getById);
  app.get("/claims/:id/explanation", claims.explanation);
  app.post(
    "/claims/:id/line-items/:lid/dispute",
    { schema: { body: disputeBodySchema } },
    disputes.open,
  );
}
