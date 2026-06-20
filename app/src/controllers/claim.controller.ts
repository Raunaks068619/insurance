// app/src/controllers/claim.controller.ts — thin HTTP handlers for the claim endpoints.
//
// A controller only translates HTTP ↔ domain: read the request, call a service, map the result to
// a response. No business logic lives here — adjudication is in claimService, assembly in
// claimReadService. The submit response and GET /claims/:id both return the same claim snapshot.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { ClaimReadService } from "../services/claim-read.service";
import type {
  AdjudicateClaimInput,
  ClaimService,
} from "../services/claim.service";

export type ClaimControllerDeps = {
  claimService: ClaimService;
  claimReadService: ClaimReadService;
};

export function createClaimController(deps: ClaimControllerDeps) {
  return {
    // POST /claims — submit + adjudicate, then return the freshly-built claim snapshot.
    submit(request: FastifyRequest, reply: FastifyReply) {
      const input = request.body as AdjudicateClaimInput;
      const { claimId } = deps.claimService.adjudicateClaim(input);
      const snapshot = deps.claimReadService.getClaimById(claimId);
      return reply.code(201).send(snapshot);
    },
  };
}
