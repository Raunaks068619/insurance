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
