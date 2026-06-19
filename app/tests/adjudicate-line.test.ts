import { describe, expect, it } from "vitest";
import { adjudicateLine } from "../src/domain/adjudication/adjudicator";
import { aCoverageRule, aLineItem, anAdjudicateInput } from "./builders";

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
