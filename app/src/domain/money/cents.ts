// app/src/domain/money/cents.ts — money is integer cents everywhere.
// formatUsd renders cents to a display string for explanations; it is presentation
// only (integer arithmetic, no floats) and never feeds back into adjudication math.
export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${remainder}`;
}
