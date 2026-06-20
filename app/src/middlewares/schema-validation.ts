// app/src/middlewares/schema-validation.ts — maps Fastify/ajv schema-validation failures to the
// PRD's intake reject shape: { field, code, message }. Pure function; the error handler wires it in.

export type ValidationIssue = { field: string; code: string; message: string };

// The subset of an ajv error object we read. Fastify exposes these on `error.validation`.
type RawValidationError = {
  keyword?: string;
  instancePath?: string;
  message?: string;
  params?: Record<string, unknown>;
};

// "/lineItems/0/billedCents" → "lineItems.0.billedCents"; "" → "".
function pathToField(instancePath: string): string {
  return instancePath.replace(/^\//, "").replace(/\//g, ".");
}

function fieldOf(err: RawValidationError): string {
  // A missing required property reports the parent path; name the absent field itself.
  if (
    err.keyword === "required" &&
    typeof err.params?.missingProperty === "string"
  ) {
    const base = pathToField(err.instancePath ?? "");
    return base
      ? `${base}.${err.params.missingProperty}`
      : err.params.missingProperty;
  }
  return pathToField(err.instancePath ?? "") || "body";
}

export function formatValidationErrors(
  validation: RawValidationError[],
): ValidationIssue[] {
  return validation.map((err) => ({
    field: fieldOf(err),
    code: err.keyword ?? "invalid",
    message: err.message ?? "invalid value",
  }));
}
