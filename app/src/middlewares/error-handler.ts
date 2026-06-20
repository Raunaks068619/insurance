// app/src/middlewares/error-handler.ts — the one central error handler for the API.
//
// Two jobs: (1) turn schema-validation failures into the PRD intake reject — 400 with
// { errors: [{ field, code, message }] }; (2) fail closed on anything unexpected with 500.
// Domain DECISIONS (denials) are never errors — they return 200 from the service. Identity/state
// errors that DO map to 4xx (e.g. a dispute on a missing line) are handled at their controller.

import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { formatValidationErrors } from "./schema-validation";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
      if (error.validation) {
        return reply
          .code(400)
          .send({ errors: formatValidationErrors(error.validation) });
      }

      const status =
        typeof error.statusCode === "number" &&
        error.statusCode >= 400 &&
        error.statusCode < 500
          ? error.statusCode
          : 500;
      return reply.code(status).send({
        error: {
          code: error.code ?? "INTERNAL_ERROR",
          message: error.message,
        },
      });
    },
  );
}
