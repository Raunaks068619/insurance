// app/src/app.ts — builds the Fastify app: wires the injected services into the route handlers.
//
// buildApp takes the services (not a DB) so tests can inject services over an in-memory DB and
// drive the routes in-process via app.inject(). The real server (index.ts) builds the services
// over a file-backed DB and passes them here.

import Fastify, { type FastifyInstance } from "fastify";
import type { ClaimControllerDeps } from "./controllers/claim.controller";
import type { DisputeControllerDeps } from "./controllers/dispute.controller";
import { registerErrorHandler } from "./middlewares/error-handler";
import { registerClaimRoutes } from "./routes/claims.routes";

export type AppDeps = ClaimControllerDeps & DisputeControllerDeps;

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  registerErrorHandler(app);
  registerClaimRoutes(app, deps);

  return app;
}
