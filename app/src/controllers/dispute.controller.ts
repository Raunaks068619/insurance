// app/src/controllers/dispute.controller.ts — thin HTTP handler for opening a dispute on a line.
//
// Maps the dispute service's domain GUARDS to HTTP at the controller (decision #16): a missing line
// is NOT_FOUND → 404, a non-terminal line is CONFLICT → 409. The dispute RESULT (the re-adjudicated
// decision + 4-value outcome) is a normal 200 — a denial is a decision, never an HTTP error.
// Services are injected via the constructor (not constructed here) to keep the test seam.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { CorrectedFacts } from "../repositories/dispute.repository";
import type { ClaimReadService } from "../services/claim-read.service";
import { DisputeError, type DisputeService } from "../services/dispute.service";

export type DisputeControllerDeps = {
  disputeService: DisputeService;
  claimReadService: ClaimReadService;
};

const STATUS_BY_CODE = { NOT_FOUND: 404, CONFLICT: 409 } as const;

export class DisputeController {
  private readonly disputeService: DisputeService;
  private readonly claimReadService: ClaimReadService;

  constructor(deps: DisputeControllerDeps) {
    this.disputeService = deps.disputeService;
    this.claimReadService = deps.claimReadService;
  }

  // POST /claims/:id/line-items/:lid/dispute
  open = (
    request: FastifyRequest<{
      Params: { id: string; lid: string };
      Body: { reason: string; corrected?: CorrectedFacts };
    }>,
    reply: FastifyReply,
  ) => {
    const { id, lid } = request.params;
    const { reason, corrected } = request.body;
    try {
      const result = this.disputeService.open({
        lineItemId: lid,
        reason,
        corrected,
      });
      // Return the outcome plus the updated claim snapshot (the new decision lives in its lines).
      return reply.code(200).send({
        disputeId: result.disputeId,
        outcome: result.outcome,
        claim: this.claimReadService.getClaimById(id),
      });
    } catch (err) {
      if (err instanceof DisputeError) {
        return reply
          .code(STATUS_BY_CODE[err.code])
          .send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  };
}
