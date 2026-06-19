// app/src/domain/entities/policy.ts — Policy entity type (plan year, dates, deductible, oop_max).
export type Policy = {
  id: string;
  memberId: string;
  planYear: number;
  effectiveDate: string; // ISO date — inclusive lower bound of the active window
  terminationDate: string; // ISO date — inclusive upper bound
  deductibleCents: number; // integer cents
  oopMaxCents: number; // integer cents
};
