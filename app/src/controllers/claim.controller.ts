// app/src/controllers/claim.controller.ts — thin HTTP handlers for the claim endpoints.
//
// A controller only translates HTTP ↔ domain: read the request, call a service, map the result to
// a response. No business logic lives here — adjudication is in claimService, assembly in
// claimReadService. Services are INJECTED via the constructor (not constructed here) so the same
// controller runs over an in-memory DB in tests and a file-backed DB in production.

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

export class ClaimController {
  private readonly claimService: ClaimService;
  private readonly claimReadService: ClaimReadService;

  constructor(deps: ClaimControllerDeps) {
    this.claimService = deps.claimService;
    this.claimReadService = deps.claimReadService;
  }

  // POST /claims — submit + adjudicate, then return the freshly-built claim snapshot. An
  // unresolvable member is an intake reject (400); any other throw falls through to the central
  // handler (500). Adjudication denials are NOT errors — they come back inside the 201 snapshot.
  submit = (request: FastifyRequest, reply: FastifyReply) => {
    const input = request.body as AdjudicateClaimInput;
    try {
      const { claimId } = this.claimService.adjudicateClaim(input);
      const snapshot = this.claimReadService.getClaimById(claimId);
      return reply.code(201).send(snapshot);
    } catch (err) {
      if (err instanceof ClaimIntakeError) {
        return reply.code(400).send({
          errors: [{ field: err.field, code: err.code, message: err.message }],
        });
      }
      throw err;
    }
  };

  // GET /claims/:id — the claim snapshot, or 404 when no such claim exists.
  getById = (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const snapshot = this.claimReadService.getClaimById(request.params.id);
    if (!snapshot) return this.claimNotFound(reply, request.params.id);
    return reply.code(200).send(snapshot);
  };

  private claimNotFound(reply: FastifyReply, id: string) {
    return reply.code(404).send({
      error: { code: "CLAIM_NOT_FOUND", message: `claim not found: ${id}` },
    });
  }
}
