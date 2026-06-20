// app/src/db/seed.ts — seed a SCENARIO MATRIX: one member per adjudication path.
//
// The assignment grades edge-case thinking (partial approvals, limit exhaustion, deductibles,
// denials). Rather than one member, we seed a member per headline scenario so every reason-code
// path is demonstrable end-to-end via `POST /claims` (see README "Demo Scenarios" / curl below).
//
// Each member = member row + active 2026 policy + coverage_rules, and (for the limit/OOP cases)
// a PRE-SEEDED accumulator row so a single claim already sits at the cap. Insertion logic mirrors
// seedWorld() in app/tests/db-helpers.ts. Idempotent per member: a member already on file is
// skipped, so `pnpm seed` over a persisted DB never violates a PK.
//
// Runnable standalone (`pnpm seed`): opens the file DB, applies the schema, seeds, and exits.
//
// ┌───────────────────┬──────────────────────────────────────────────┬─────────────────────────┐
// │ member            │ submit this line                             │ expected outcome        │
// ├───────────────────┼──────────────────────────────────────────────┼─────────────────────────┤
// │ mem_approved      │ PCP_VISIT                                    │ APPROVED (copay)        │
// │ mem_prior_auth    │ MRI (no priorAuthPresent)                    │ DENIED PRIOR_AUTH_REQ   │
// │ mem_excluded      │ ADULT_DENTAL                                 │ DENIED EXCLUDED         │
// │ mem_no_coverage   │ LAB (no rule on file)                        │ DENIED NO_COVERAGE      │
// │ mem_inactive      │ PCP_VISIT, serviceDate 2026-…                │ DENIED POLICY_NOT_ACTIVE│
// │ mem_limit         │ CHIROPRACTIC (12/12 visits pre-used)         │ DENIED LIMIT_EXCEEDED   │
// │ mem_deductible    │ SPECIALIST_VISIT $800 (deductible unmet)     │ APPROVED, member owes   │
// │ mem_oop           │ SPECIALIST_VISIT $1000 (OOP near max)        │ APPROVED OOP_MAX_REACHED│
// │ mem_partial       │ PCP_VISIT + ADULT_DENTAL + PREVENTIVE (1 claim)│ PARTIALLY_APPROVED     │
// │ mem_no_policy     │ any line                                     │ 400 intake reject       │
// └───────────────────┴──────────────────────────────────────────────┴─────────────────────────┘

import { eq } from "drizzle-orm";
import type { CoverageRule } from "../domain/types";
import { createMemberRepository } from "../repositories/member.repository";
import { type Db, createDb } from "./connection";
import { applySchema } from "./migrate";
import { accumulators, coverageRules, members, policies } from "./schema";

type SeedRule = Partial<CoverageRule> & { serviceCode: string };

// A pre-existing accumulator draw, so a single demo claim already sits at the cap.
type SeedAccumulator = {
  dimension: string; // 'OOP' | 'DEDUCTIBLE' | 'LIMIT:<service_code>'
  unit: "CENTS" | "COUNT";
  usedCents?: number;
  usedCount?: number;
};

type SeedMember = {
  id: string;
  name: string;
  dob: string;
  // Omit `policy` entirely for the no-policy intake-reject case.
  policy?: {
    deductibleCents?: number;
    oopMaxCents?: number;
    effectiveDate?: string;
    terminationDate?: string;
  };
  rules?: SeedRule[];
  accumulators?: SeedAccumulator[];
};

const PLAN_YEAR = "2026";

// Common cost-share shapes, named for readability at the call sites below.
const copay = (cents: number): CoverageRule["costShare"] => ({
  type: "copay",
  copayCents: cents,
});
const coinsurance = (rate: number): CoverageRule["costShare"] => ({
  type: "coinsurance",
  rate,
});
const FULL: CoverageRule["costShare"] = { type: "full_coverage" };

// The scenario matrix. Service codes are from the CLOSED 12-entry catalog (ck_cr_service_code).
const SEED_MEMBERS: SeedMember[] = [
  // 1) Happy path — a flat copay visit approves and bills the copay to the member.
  {
    id: "mem_approved",
    name: "Alice Approved",
    dob: "1988-03-12",
    rules: [
      {
        serviceCode: "PCP_VISIT",
        costShare: copay(2_500),
        appliesDeductible: true,
      },
      { serviceCode: "PREVENTIVE", costShare: FULL },
    ],
  },

  // 2) Prior-auth gate — MRI needs auth; a line without it denies (re-submit with
  //    priorAuthPresent:true to see it approve, or dispute it).
  {
    id: "mem_prior_auth",
    name: "Paul PriorAuth",
    dob: "1979-07-22",
    rules: [
      {
        serviceCode: "MRI",
        costShare: coinsurance(0.2),
        appliesDeductible: true,
        requiresPriorAuth: true,
      },
    ],
  },

  // 3) Excluded benefit — explicitly carved out of the plan.
  {
    id: "mem_excluded",
    name: "Ed Excluded",
    dob: "1965-11-02",
    rules: [{ serviceCode: "ADULT_DENTAL", covered: false, excluded: true }],
  },

  // 4) No coverage — member has a policy but NO rule for the billed service.
  {
    id: "mem_no_coverage",
    name: "Nora NoCoverage",
    dob: "1992-01-30",
    rules: [{ serviceCode: "PCP_VISIT", costShare: copay(2_500) }], // submit LAB instead
  },

  // 5) Policy not active — coverage window is 2025; a 2026 service date falls outside it.
  {
    id: "mem_inactive",
    name: "Ivan Inactive",
    dob: "1983-09-09",
    policy: { effectiveDate: "2025-01-01", terminationDate: "2025-12-31" },
    rules: [{ serviceCode: "PCP_VISIT", costShare: copay(2_500) }],
  },

  // 6) Limit exhausted — 12/12 chiropractic visits already used this plan year.
  {
    id: "mem_limit",
    name: "Lily Limit",
    dob: "1990-06-18",
    rules: [
      {
        serviceCode: "CHIROPRACTIC",
        costShare: coinsurance(0.2),
        appliesDeductible: true,
        limit: { unit: "visits", count: 12 },
      },
    ],
    accumulators: [
      { dimension: "LIMIT:CHIROPRACTIC", unit: "COUNT", usedCount: 12 },
    ],
  },

  // 7) Deductible draw — coinsurance with an UNMET deductible; the member owes the
  //    deductible portion first, then their coinsurance share of the remainder.
  {
    id: "mem_deductible",
    name: "Dana Deductible",
    dob: "1975-12-25",
    policy: { deductibleCents: 50_000 },
    rules: [
      {
        serviceCode: "SPECIALIST_VISIT",
        costShare: coinsurance(0.3),
        appliesDeductible: true,
      },
    ],
  },

  // 8) OOP max — member is $100 short of their out-of-pocket max; a big coinsurance line
  //    fills the OOP exactly to the cap and the plan absorbs the rest.
  {
    id: "mem_oop",
    name: "Olive OOP",
    dob: "1968-04-04",
    policy: { oopMaxCents: 300_000 },
    rules: [
      // appliesDeductible:false isolates the OOP-cap behavior from any deductible draw.
      { serviceCode: "SPECIALIST_VISIT", costShare: coinsurance(0.5) },
    ],
    accumulators: [{ dimension: "OOP", unit: "CENTS", usedCents: 290_000 }],
  },

  // 9) Partial approval — one claim, three lines: two covered, one excluded → the claim
  //    aggregates to PARTIALLY_APPROVED. This is the brief's own example.
  {
    id: "mem_partial",
    name: "Pat Partial",
    dob: "1995-08-14",
    rules: [
      {
        serviceCode: "PCP_VISIT",
        costShare: copay(2_500),
        appliesDeductible: true,
      },
      { serviceCode: "PREVENTIVE", costShare: FULL },
      { serviceCode: "ADULT_DENTAL", covered: false, excluded: true },
    ],
  },

  // 10) No policy on file — intake cannot resolve the member to a policy → 400 reject
  //     (this is an identity failure, NOT an adjudication decision).
  {
    id: "mem_no_policy",
    name: "Nina NoPolicy",
    dob: "2000-02-29",
  },
];

// Insert one member's full world (member + optional policy + rules + pre-seeded accumulators).
// Idempotent: skips entirely if the member already exists. Returns true if it inserted.
function seedMember(db: Db, m: SeedMember): boolean {
  const exists = db.select().from(members).where(eq(members.id, m.id)).all();
  if (exists.length > 0) return false;

  // name/dob are PHI — inserted via the member repo so they are encrypted at rest.
  createMemberRepository(db).insertMember({
    id: m.id,
    name: m.name,
    dob: m.dob,
  });

  if (!m.policy && !m.rules && !m.accumulators) return true; // no-policy case

  const policyId = `pol_${m.id}`;
  db.insert(policies)
    .values({
      id: policyId,
      memberId: m.id,
      planYear: PLAN_YEAR,
      effectiveDate: m.policy?.effectiveDate ?? "2026-01-01",
      terminationDate: m.policy?.terminationDate ?? "2026-12-31",
      deductibleCents: m.policy?.deductibleCents ?? 50_000,
      oopMaxCents: m.policy?.oopMaxCents ?? 300_000,
    })
    .run();

  (m.rules ?? []).forEach((r, i) => {
    const costShare = r.costShare ?? FULL;
    const limit = r.limit ?? { unit: "none" };
    db.insert(coverageRules)
      .values({
        id: `cr_${m.id}_${i}`,
        policyId,
        serviceCode: r.serviceCode,
        covered: r.covered ?? true,
        excluded: r.excluded ?? false,
        costShareType: costShare.type,
        copayCents: costShare.type === "copay" ? costShare.copayCents : null,
        coinsuranceRate:
          costShare.type === "coinsurance" ? costShare.rate : null,
        appliesDeductible: r.appliesDeductible ?? false,
        limitUnit: limit.unit,
        limitAmountCents: limit.unit === "dollars" ? limit.amountCents : null,
        limitCount: limit.unit === "visits" ? limit.count : null,
        requiresPriorAuth: r.requiresPriorAuth ?? false,
      })
      .run();
  });

  (m.accumulators ?? []).forEach((a, i) => {
    db.insert(accumulators)
      .values({
        id: `acc_${m.id}_${i}`,
        memberId: m.id,
        planYear: PLAN_YEAR,
        dimension: a.dimension,
        unit: a.unit,
        usedCents: a.usedCents ?? 0,
        usedCount: a.usedCount ?? 0,
      })
      .run();
  });

  return true;
}

// Seed the whole scenario matrix. Idempotent per member. Returns the ids that were inserted.
export function seed(db: Db): { seeded: string[]; skipped: string[] } {
  const seeded: string[] = [];
  const skipped: string[] = [];
  for (const m of SEED_MEMBERS) {
    (seedMember(db, m) ? seeded : skipped).push(m.id);
  }
  return { seeded, skipped };
}

// CLI entry: `pnpm seed` (DB_PATH overridable). Applies the schema first so it works on a fresh DB.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.DB_PATH ?? "./claims.db";
  const { db, sqlite } = createDb(dbPath);
  applySchema(sqlite);
  const result = seed(db);
  sqlite.close();
  console.log(
    `seeded ${dbPath}: ${result.seeded.length} member(s) inserted` +
      (result.skipped.length
        ? `, ${result.skipped.length} already present`
        : ""),
  );
  console.log("  inserted:", result.seeded.join(", ") || "(none)");
  if (result.skipped.length)
    console.log("  skipped: ", result.skipped.join(", "));
}
