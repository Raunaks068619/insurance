// app/src/routes/claims.routes.ts — the /claims endpoints. Routes only list URL+method → handler;
// validation lives in the route schema, request/response mapping in the controllers, business logic
// in the services.

import type { FastifyInstance } from "fastify";
import {
  ClaimController,
  type ClaimControllerDeps,
} from "../controllers/claim.controller";
import {
  DisputeController,
  type DisputeControllerDeps,
} from "../controllers/dispute.controller";
import { disputeBodySchema } from "../schemas/api/dispute.schema";
import { submitClaimBodySchema } from "../schemas/api/submit-claim.schema";

export function registerClaimRoutes(
  app: FastifyInstance,
  deps: ClaimControllerDeps & DisputeControllerDeps,
): void {
  const claims = new ClaimController(deps);
  const disputes = new DisputeController(deps);

  // POST /claims — submit a claim and adjudicate every line
  app.post(
    "/claims",
    { schema: { body: submitClaimBodySchema } },
    claims.submit,
  );

  // GET /claims/:id — fetch a claim snapshot (status, lines, payable sum, timeline)
  app.get("/claims/:id", claims.getById);

  // POST /claims/:id/line-items/:lid/dispute — dispute one line's decision
  app.post(
    "/claims/:id/line-items/:lid/dispute",
    { schema: { body: disputeBodySchema } },
    disputes.open,
  );
}
