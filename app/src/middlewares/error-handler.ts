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
    (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      if (error.validation) {
        return reply
          .code(400)
          .send({ errors: formatValidationErrors(error.validation) });
      }

      // An intentional client error (a 4xx thrown upstream, e.g. Fastify's bad-JSON body) keeps its
      // code/message — that detail is safe and useful. Anything else fails closed as a GENERIC 500:
      // the underlying message can carry internals (DB table/column names, stack hints), so it is
      // logged server-side and never echoed to the client.
      const isClientError =
        typeof error.statusCode === "number" &&
        error.statusCode >= 400 &&
        error.statusCode < 500;

      if (isClientError) {
        return reply.code(error.statusCode as number).send({
          error: { code: error.code ?? "BAD_REQUEST", message: error.message },
        });
      }

      request.log.error(error); // keep the real cause for operators; no-op when logging is off
      return reply.code(500).send({
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
      });
    },
  );
}
