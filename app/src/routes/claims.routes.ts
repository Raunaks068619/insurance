// app/src/routes/claims.routes.ts — registers the /claims endpoints on a Fastify instance.
// Routes only wire URL+method → controller handler; validation schemas and handlers live elsewhere.

import type { FastifyInstance } from "fastify";
import {
  type ClaimControllerDeps,
  createClaimController,
} from "../controllers/claim.controller";

export function registerClaimRoutes(
  app: FastifyInstance,
  deps: ClaimControllerDeps,
): void {
  const claims = createClaimController(deps);

  app.post("/claims", claims.submit);
}
