// app/src/schemas/api/dispute.schema.ts — JSON Schema for the dispute request body.
//
// A dispute carries a member rationale (surfaced verbatim) and OPTIONAL corrected facts — the only
// amendable line fields (prior auth / service code / billed / units). Validated before the handler.

export const disputeBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: {
    reason: { type: "string", minLength: 1 },
    corrected: {
      type: "object",
      additionalProperties: false,
      properties: {
        priorAuthPresent: { type: "boolean" },
        serviceCode: { type: "string", minLength: 1 },
        billedCents: { type: "integer", minimum: 1 },
        units: { type: "integer", minimum: 1 },
      },
    },
  },
} as const;
