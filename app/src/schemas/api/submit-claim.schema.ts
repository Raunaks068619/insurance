// app/src/schemas/api/submit-claim.schema.ts — JSON Schema for the POST /claims request body.
//
// Fastify validates the body against this (via ajv) BEFORE the handler runs, so a malformed claim
// never reaches the service and nothing is persisted (PRD intake N2). This guards STRUCTURE only:
// required fields, ≥1 line, a positive-integer billed amount, a date-shaped service_date. Identity
// (member exists) and coverage (policy active, service covered) are resolved downstream.

export const submitClaimBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["memberId", "serviceDate", "lineItems"],
  properties: {
    memberId: { type: "string", minLength: 1 },
    serviceDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, // ISO calendar date
    provider: { type: "string" }, // optional PHI, not adjudicated
    diagnosisCode: { type: "string" }, // optional PHI, not adjudicated
    lineItems: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["serviceCode", "billedCents"],
        properties: {
          serviceCode: { type: "string", minLength: 1 },
          billedCents: { type: "integer", minimum: 1 }, // positive integer cents
          units: { type: "integer", minimum: 1 },
          priorAuthPresent: { type: "boolean" },
        },
      },
    },
  },
} as const;
