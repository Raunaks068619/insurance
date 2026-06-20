// app/src/app.ts — builds the Fastify app: wires the injected services into the route handlers.
//
// buildApp takes the services (not a DB) so tests can inject services over an in-memory DB and
// drive the routes in-process via app.inject(). The real server (index.ts) builds the services
// over a file-backed DB and passes them here.

import Fastify, { type FastifyInstance } from "fastify";
import type { ClaimControllerDeps } from "./controllers/claim.controller";
import { registerClaimRoutes } from "./routes/claims.routes";

export type AppDeps = ClaimControllerDeps;

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  registerClaimRoutes(app, deps);

  return app;
}
