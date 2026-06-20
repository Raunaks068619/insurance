// app/src/controllers/claim.controller.ts — thin HTTP handlers for the claim endpoints.
//
// A controller only translates HTTP ↔ domain: read the request, call a service, map the result to
// a response. No business logic lives here — adjudication is in claimService, assembly in
// claimReadService. The submit response and GET /claims/:id both return the same claim snapshot.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { ClaimReadService } from "../services/claim-read.service";
import {
  type AdjudicateClaimInput,
  ClaimIntakeError,
  type ClaimService,
} from "../services/claim.service";

export type ClaimControllerDeps = {
  claimService: ClaimService;
  claimReadService: ClaimReadService;
};

export function createClaimController(deps: ClaimControllerDeps) {
  return {
    // POST /claims — submit + adjudicate, then return the freshly-built claim snapshot. An
    // unresolvable member is an intake reject (400); any other throw falls through to the central
    // handler (500). Adjudication denials are NOT errors — they come back inside the 201 snapshot.
    submit(request: FastifyRequest, reply: FastifyReply) {
      const input = request.body as AdjudicateClaimInput;
      try {
        const { claimId } = deps.claimService.adjudicateClaim(input);
        const snapshot = deps.claimReadService.getClaimById(claimId);
        return reply.code(201).send(snapshot);
      } catch (err) {
        if (err instanceof ClaimIntakeError) {
          return reply.code(400).send({
            errors: [
              { field: err.field, code: err.code, message: err.message },
            ],
          });
        }
        throw err;
      }
    },

    // GET /claims/:id — return the claim snapshot, or 404 when no such claim exists.
    getById(
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) {
      const snapshot = deps.claimReadService.getClaimById(request.params.id);
      if (!snapshot) {
        return reply.code(404).send({
          error: {
            code: "CLAIM_NOT_FOUND",
            message: `claim not found: ${request.params.id}`,
          },
        });
      }
      return reply.code(200).send(snapshot);
    },

    // GET /claims/:id/explanation — the per-line EOB, or 404 when no such claim exists.
    explanation(
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) {
      const eob = deps.claimReadService.getExplanation(request.params.id);
      if (!eob) {
        return reply.code(404).send({
          error: {
            code: "CLAIM_NOT_FOUND",
            message: `claim not found: ${request.params.id}`,
          },
        });
      }
      return reply.code(200).send(eob);
    },
  };
}
