import { describe, expect, it } from "vitest";
import { adjudicateLine } from "../src/domain/adjudication/adjudicator";
import { aCoverageRule, aLineItem, anAccumulator, anAdjudicateInput } from "./builders";

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

describe("adjudicateLine — copay", () => {
  it("charges the flat copay and pays the rest when the allowed amount exceeds the copay", () => {
    // Arrange — $25 copay on a $180 office visit; copay waives the deductible.
    const rule = aCoverageRule({
      serviceCode: "OFFICE_VISIT",
      costShare: { type: "copay", copayCents: 2_500 }, // $25.00
      appliesDeductible: false,
    });
    const line = aLineItem({ serviceCode: "OFFICE_VISIT", billedCents: 18_000 }); // $180.00
    const result = adjudicateLine(anAdjudicateInput({ line, rule }));

    expect(result.status).toBe("APPROVED");
    expect(result.memberResponsibilityCents).toBe(2_500); // member pays the copay
    expect(result.payableCents).toBe(15_500); // plan pays the remainder

    // Covered-line invariant: plan + member === billed.
    expect(result.payableCents + result.memberResponsibilityCents).toBe(line.billedCents);

    // Copay waives the deductible but counts toward OOP.
    expect(result.deltas).toEqual({ deductibleIncCents: 0, oopIncCents: 2_500, limitInc: 0 });
    expect(result.reasons).toEqual(["APPROVED", "COPAY_APPLIED"]);
  });

  it("caps the member charge at the allowed amount when the copay exceeds it (min clamp)", () => {
    // Arrange — $50 copay but the service only costs $30; member can't owe more than billed.
    const rule = aCoverageRule({
      serviceCode: "OFFICE_VISIT",
      costShare: { type: "copay", copayCents: 5_000 }, // $50.00
      appliesDeductible: false,
    });
    const line = aLineItem({ serviceCode: "OFFICE_VISIT", billedCents: 3_000 }); // $30.00
    const result = adjudicateLine(anAdjudicateInput({ line, rule }));

    expect(result.status).toBe("APPROVED");
    expect(result.memberResponsibilityCents).toBe(3_000); // clamped to billed
    expect(result.payableCents).toBe(0); // plan pays nothing
    expect(result.deltas).toEqual({ deductibleIncCents: 0, oopIncCents: 3_000, limitInc: 0 });
    expect(result.reasons).toEqual(["APPROVED", "COPAY_APPLIED"]);
  });
});

describe("adjudicateLine — coinsurance", () => {
  it("charges the coinsurance rate on the full allowed when the deductible is already met", () => {
    // Arrange — 20% coinsurance, deductible fully met → no deductible draw.
    const rule = aCoverageRule({
      serviceCode: "IMAGING",
      costShare: { type: "coinsurance", rate: 0.2 }, // member pays 20%
      appliesDeductible: true,
    });
    const line = aLineItem({ serviceCode: "IMAGING", billedCents: 10_000 }); // $100.00
    const acc = anAccumulator({ deductibleMetCents: 50_000 }); // = policy deductible → met
    const result = adjudicateLine(anAdjudicateInput({ line, rule, acc }));

    expect(result.status).toBe("APPROVED");
    expect(result.memberResponsibilityCents).toBe(2_000); // 20% of $100
    expect(result.payableCents).toBe(8_000); // plan pays the other 80%
    expect(result.payableCents + result.memberResponsibilityCents).toBe(line.billedCents);
    expect(result.deltas).toEqual({ deductibleIncCents: 0, oopIncCents: 2_000, limitInc: 0 });
    expect(result.reasons).toEqual(["APPROVED", "COINSURANCE_APPLIED"]);
  });

  it("sends the whole amount to the deductible (coinsurance 0, plan 0) when allowed is below the remaining deductible", () => {
    // Arrange — fresh $500 deductible; a $300 service is fully absorbed by it.
    const rule = aCoverageRule({
      serviceCode: "SURGERY",
      costShare: { type: "coinsurance", rate: 0.2 },
      appliesDeductible: true,
    });
    const line = aLineItem({ serviceCode: "SURGERY", billedCents: 30_000 }); // $300.00
    const acc = anAccumulator({ deductibleMetCents: 0 }); // remaining deductible = $500
    const result = adjudicateLine(anAdjudicateInput({ line, rule, acc }));

    expect(result.status).toBe("APPROVED");
    expect(result.memberResponsibilityCents).toBe(30_000); // all to deductible
    expect(result.payableCents).toBe(0); // plan pays nothing until the deductible is met
    expect(result.deltas).toEqual({ deductibleIncCents: 30_000, oopIncCents: 30_000, limitInc: 0 });
    expect(result.reasons).toEqual(["APPROVED", "DEDUCTIBLE_APPLIED", "COINSURANCE_APPLIED"]);
  });

  it("splits a deductible-crossing line into deductible draw + coinsurance on the remainder", () => {
    // Arrange — $200 of a $500 deductible met; a $1,200 surgery crosses it.
    const rule = aCoverageRule({
      serviceCode: "SURGERY",
      costShare: { type: "coinsurance", rate: 0.2 },
      appliesDeductible: true,
    });
    const line = aLineItem({ serviceCode: "SURGERY", billedCents: 120_000 }); // $1,200.00
    const acc = anAccumulator({ deductibleMetCents: 20_000 }); // remaining deductible = $300
    const result = adjudicateLine(anAdjudicateInput({ line, rule, acc }));

    // $300 finishes the deductible; 20% of the remaining $900 = $180. Member = $480.
    expect(result.memberResponsibilityCents).toBe(48_000);
    expect(result.payableCents).toBe(72_000);
    expect(result.payableCents + result.memberResponsibilityCents).toBe(line.billedCents);
    expect(result.deltas).toEqual({ deductibleIncCents: 30_000, oopIncCents: 48_000, limitInc: 0 });
    expect(result.reasons).toEqual(["APPROVED", "DEDUCTIBLE_APPLIED", "COINSURANCE_APPLIED"]);
  });

  it("rounds the coinsurance share half-up and never loses a cent (member + plan === allowed)", () => {
    // Arrange — 20% of $33.33 = $6.666 → rounds half-up to $6.67; deductible already met.
    const rule = aCoverageRule({
      serviceCode: "IMAGING",
      costShare: { type: "coinsurance", rate: 0.2 },
      appliesDeductible: true,
    });
    const line = aLineItem({ serviceCode: "IMAGING", billedCents: 3_333 }); // $33.33
    const acc = anAccumulator({ deductibleMetCents: 50_000 }); // met → pure coinsurance
    const result = adjudicateLine(anAdjudicateInput({ line, rule, acc }));

    expect(result.memberResponsibilityCents).toBe(667); // round(0.20 × 3333) = round(666.6)
    expect(result.payableCents).toBe(2_666); // computed as allowed − member
    expect(result.payableCents + result.memberResponsibilityCents).toBe(3_333); // no lost cent
  });
});
