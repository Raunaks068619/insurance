import { describe, expect, it } from "vitest";
import { adjudicateLine } from "../src/domain/adjudication/adjudicator";
import { aCoverageRule, aLineItem, anAdjudicateInput } from "./builders";

describe("adjudicateLine — no coverage rule", () => {
  it("denies the line with NO_COVERAGE and pays nothing when no rule matches the service", () => {
    // Arrange — the one load-bearing fact: there is no coverage rule for this service.
    const line = aLineItem({ serviceCode: "EXPERIMENTAL_THERAPY", billedCents: 12_000 });
    const input = anAdjudicateInput({ line, rule: undefined });

    // Act
    const result = adjudicateLine(input);

    // Assert — a no-coverage line is a *processed* denial (HTTP 200 decision), not an error.
    expect(result.status).toBe("DENIED");
    expect(result.payableCents).toBe(0); // plan pays nothing
    expect(result.memberResponsibilityCents).toBe(0); // not a cost-share; member owes the provider directly

    // Dominant code is NO_COVERAGE.
    expect(result.reasons).toEqual(["NO_COVERAGE"]);

    // A gate denial touches no accumulator.
    expect(result.deltas).toEqual({ deductibleIncCents: 0, oopIncCents: 0, limitInc: 0 });

    // The explanation says why, in plain words.
    expect(result.explanation).toMatch(/no.*coverage|not covered/i);
  });
});

describe("adjudicateLine — excluded service", () => {
  it("denies the line with EXCLUDED and pays nothing when the rule excludes the service", () => {
    // Arrange — the one load-bearing fact: a rule exists but the service is excluded.
    const rule = aCoverageRule({ serviceCode: "ADULT_DENTAL", excluded: true });
    const line = aLineItem({ serviceCode: "ADULT_DENTAL", billedCents: 20_000 });
    const input = anAdjudicateInput({ line, rule });

    // Act
    const result = adjudicateLine(input);

    // Assert — an excluded line is a processed denial, distinct from "no rule at all".
    expect(result.status).toBe("DENIED");
    expect(result.payableCents).toBe(0); // plan pays nothing
    expect(result.memberResponsibilityCents).toBe(0); // not a cost-share

    // Dominant code is EXCLUDED (not NO_COVERAGE).
    expect(result.reasons).toEqual(["EXCLUDED"]);

    // A gate denial touches no accumulator.
    expect(result.deltas).toEqual({ deductibleIncCents: 0, oopIncCents: 0, limitInc: 0 });

    // The explanation says it's an excluded benefit.
    expect(result.explanation).toMatch(/exclud/i);
  });
});

describe("adjudicateLine — rule present but not covered", () => {
  it("denies with NO_COVERAGE when a rule exists but covered is false", () => {
    const rule = aCoverageRule({ serviceCode: "COSMETIC", covered: false });
    const line = aLineItem({ serviceCode: "COSMETIC", billedCents: 30_000 });
    const result = adjudicateLine(anAdjudicateInput({ line, rule }));

    expect(result.status).toBe("DENIED");
    expect(result.payableCents).toBe(0);
    expect(result.reasons).toEqual(["NO_COVERAGE"]);
    expect(result.deltas).toEqual({ deductibleIncCents: 0, oopIncCents: 0, limitInc: 0 });
  });
});

describe("adjudicateLine — policy not active", () => {
  it("denies with POLICY_NOT_ACTIVE when the service date is outside the policy window", () => {
    // Default policy window is 2026-01-01..2026-12-31; this date is after it.
    const result = adjudicateLine(anAdjudicateInput({ serviceDate: "2027-03-01" }));

    expect(result.status).toBe("DENIED");
    expect(result.payableCents).toBe(0);
    expect(result.reasons).toEqual(["POLICY_NOT_ACTIVE"]);
    expect(result.deltas).toEqual({ deductibleIncCents: 0, oopIncCents: 0, limitInc: 0 });
  });
});

describe("adjudicateLine — prior auth missing", () => {
  it("cleanly denies with PRIOR_AUTH_REQUIRED when auth is required but not present", () => {
    const rule = aCoverageRule({ serviceCode: "MRI", requiresPriorAuth: true });
    const line = aLineItem({ serviceCode: "MRI", priorAuthPresent: false, billedCents: 90_000 });
    const result = adjudicateLine(anAdjudicateInput({ line, rule }));

    expect(result.status).toBe("DENIED");
    expect(result.payableCents).toBe(0);
    expect(result.reasons).toEqual(["PRIOR_AUTH_REQUIRED"]);
    expect(result.deltas).toEqual({ deductibleIncCents: 0, oopIncCents: 0, limitInc: 0 });
  });
});

describe("adjudicateLine — duplicate line", () => {
  it("denies with DUPLICATE_LINE_ITEM when the fingerprint was already adjudicated", () => {
    const result = adjudicateLine(anAdjudicateInput({ alreadyAdjudicated: true }));

    expect(result.status).toBe("DENIED");
    expect(result.payableCents).toBe(0);
    expect(result.reasons).toEqual(["DUPLICATE_LINE_ITEM"]);
    expect(result.deltas).toEqual({ deductibleIncCents: 0, oopIncCents: 0, limitInc: 0 });
  });
});

describe("adjudicateLine — full coverage", () => {
  it("pays the plan 100% and the member nothing for a full-coverage service", () => {
    // Arrange — only the load-bearing facts are explicit; builders fill the rest.
    const rule = aCoverageRule({
      serviceCode: "PREVENTIVE",
      costShare: { type: "full_coverage" },
      appliesDeductible: false,
    });
    const line = aLineItem({ serviceCode: "PREVENTIVE", billedCents: 12_000 }); // $120.00
    const input = anAdjudicateInput({ rule, line });

    // Act
    const result = adjudicateLine(input);

    // Assert — domain outcomes, never HTTP status or return types.
    expect(result.status).toBe("APPROVED");
    expect(result.payableCents).toBe(12_000); // plan pays 100%
    expect(result.memberResponsibilityCents).toBe(0); // member owes nothing

    // Invariant for every covered line: payable + member === billed.
    expect(result.payableCents + result.memberResponsibilityCents).toBe(line.billedCents);

    // reasons[] is an array, dominant code first; full coverage produces exactly [APPROVED].
    expect(result.reasons).toEqual(["APPROVED"]);

    // Full coverage touches no accumulator.
    expect(result.deltas).toEqual({ deductibleIncCents: 0, oopIncCents: 0, limitInc: 0 });

    // The EOB sentence cites the rule and the numbers used.
    expect(result.explanation).toMatch(/full.coverage|100%/i);
    expect(result.explanation).toMatch(/\$?120(\.00)?/);
  });
});
