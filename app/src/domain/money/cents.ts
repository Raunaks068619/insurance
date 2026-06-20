// app/src/domain/money/cents.ts — money is integer cents everywhere.
// formatUsd renders cents to a display string for explanations; it is presentation
// only (integer arithmetic, no floats) and never feeds back into adjudication math.

// Upper sanity bound for any billed amount, in cents. A single line item is never legitimately
// this large; the cap's real job is to keep amounts well inside JS's safe-integer range so they
// always bind as SQLite INTEGER (never REAL). Out-of-range amounts are an INTAKE reject (HTTP 400),
// the mirror of the `minimum: 1` lower bound — NOT an adjudication denial (no insurance reason code
// means "number too big"). See submit-claim.schema.ts / dispute.schema.ts.
export const MAX_BILLED_CENTS = 10_000_000_000; // $100,000,000.00
export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${remainder}`;
}
