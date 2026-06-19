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

describe("adjudicateLine — visit limit", () => {
  it("approves a visit and consumes one unit when the visit cap is not yet reached", () => {
    // Arrange — PT, 20 visits/yr, $25 copay; 5 visits already used (15 remain).
    const rule = aCoverageRule({
      serviceCode: "PHYSICAL_THERAPY",
      costShare: { type: "copay", copayCents: 2_500 },
      appliesDeductible: false,
      limit: { unit: "visits", count: 20 },
    });
    const line = aLineItem({ serviceCode: "PHYSICAL_THERAPY", billedCents: 15_000 }); // $150.00
    const acc = anAccumulator({ limitUsed: 5 }); // 5 of 20 visits used
    const result = adjudicateLine(anAdjudicateInput({ line, rule, acc }));

    expect(result.status).toBe("APPROVED");
    expect(result.memberResponsibilityCents).toBe(2_500); // the copay
    expect(result.payableCents).toBe(12_500);
    expect(result.deltas).toEqual({ deductibleIncCents: 0, oopIncCents: 2_500, limitInc: 1 }); // one visit consumed
    expect(result.reasons).toEqual(["APPROVED", "COPAY_APPLIED"]);
  });

  it("denies the whole visit with LIMIT_EXCEEDED once the visit cap is reached", () => {
    // Arrange — PT, 20 visits/yr; all 20 already used → no partial visit, clean denial.
    const rule = aCoverageRule({
      serviceCode: "PHYSICAL_THERAPY",
      costShare: { type: "copay", copayCents: 2_500 },
      appliesDeductible: false,
      limit: { unit: "visits", count: 20 },
    });
    const line = aLineItem({ serviceCode: "PHYSICAL_THERAPY", billedCents: 15_000 });
    const acc = anAccumulator({ limitUsed: 20 }); // cap reached
    const result = adjudicateLine(anAdjudicateInput({ line, rule, acc }));

    expect(result.status).toBe("DENIED");
    expect(result.payableCents).toBe(0);
    expect(result.memberResponsibilityCents).toBe(0);
    expect(result.reasons).toEqual(["LIMIT_EXCEEDED"]);
    expect(result.deltas).toEqual({ deductibleIncCents: 0, oopIncCents: 0, limitInc: 0 });
  });
});

describe("adjudicateLine — dollar limit", () => {
  it("approves within the dollar cap and accrues the plan pay toward the limit", () => {
    // Arrange — chiro, $1,500/yr cap, $25 copay; nothing used yet.
    const rule = aCoverageRule({
      serviceCode: "CHIROPRACTIC",
      costShare: { type: "copay", copayCents: 2_500 },
      appliesDeductible: false,
      limit: { unit: "dollars", amountCents: 150_000 }, // $1,500.00/yr
    });
    const line = aLineItem({ serviceCode: "CHIROPRACTIC", billedCents: 40_000 }); // $400.00
    const acc = anAccumulator({ limitUsed: 0 });
    const result = adjudicateLine(anAdjudicateInput({ line, rule, acc }));

    expect(result.status).toBe("APPROVED");
    expect(result.memberResponsibilityCents).toBe(2_500); // copay
    expect(result.payableCents).toBe(37_500); // plan pays the rest
    // The dollar limit accrues the PLAN PAY (not billed, not the copay).
    expect(result.deltas).toEqual({ deductibleIncCents: 0, oopIncCents: 2_500, limitInc: 37_500 });
    expect(result.reasons).toEqual(["APPROVED", "COPAY_APPLIED"]);
  });

  it("straddles the dollar cap: plan caps at the remaining, the shortfall falls to the member, line stays APPROVED", () => {
    // Arrange — chiro, $1,500/yr cap, $1,400 already used ($100 remains). A full-coverage
    // $300 service: the plan would pay $300 but only $100 of the cap is left.
    const rule = aCoverageRule({
      serviceCode: "CHIROPRACTIC",
      costShare: { type: "full_coverage" },
      appliesDeductible: false,
      limit: { unit: "dollars", amountCents: 150_000 }, // $1,500.00/yr
    });
    const line = aLineItem({ serviceCode: "CHIROPRACTIC", billedCents: 30_000 }); // $300.00
    const acc = anAccumulator({ limitUsed: 140_000 }); // $1,400 used → $100 remains
    const result = adjudicateLine(anAdjudicateInput({ line, rule, acc }));

    expect(result.status).toBe("APPROVED"); // a straddle is NOT a denial
    expect(result.payableCents).toBe(10_000); // plan capped at the remaining $100
    expect(result.memberResponsibilityCents).toBe(20_000); // the over-limit $200 shortfall
    expect(result.payableCents + result.memberResponsibilityCents).toBe(line.billedCents); // invariant holds
    // The cap is exhausted; over-limit shortfall does NOT accrue to OOP.
    expect(result.deltas).toEqual({ deductibleIncCents: 0, oopIncCents: 0, limitInc: 10_000 });
    expect(result.reasons).toEqual(["APPROVED", "LIMIT_EXCEEDED"]);
  });
});

describe("adjudicateLine — OOP maximum", () => {
  it("caps the member at the OOP max and refunds the excess to the plan", () => {
    // Arrange — OOP max $3,000, already $2,900 met → only $100 of room left.
    const rule = aCoverageRule({
      serviceCode: "HOSPITAL",
      costShare: { type: "coinsurance", rate: 0.5 }, // member 50%
      appliesDeductible: false,
    });
    const line = aLineItem({ serviceCode: "HOSPITAL", billedCents: 60_000 }); // $600.00
    const acc = anAccumulator({ oopMetCents: 290_000 }); // $2,900 of $3,000 used
    const result = adjudicateLine(anAdjudicateInput({ line, rule, acc }));

    // 50% of $600 = $300, but only $100 of room remains → member pays $100, plan eats $500.
    expect(result.status).toBe("APPROVED");
    expect(result.memberResponsibilityCents).toBe(10_000); // capped at the $100 of room
    expect(result.payableCents).toBe(50_000); // plan's $300 + the $200 refunded excess
    expect(result.payableCents + result.memberResponsibilityCents).toBe(line.billedCents);
    expect(result.deltas.oopIncCents).toBe(10_000); // OOP filled exactly to the max
    expect(result.reasons).toEqual(["APPROVED", "COINSURANCE_APPLIED", "OOP_MAX_REACHED"]);
  });

  it("pays the line 100% with the member owing nothing once the OOP max is already met", () => {
    // Arrange — OOP max $3,000, already fully met. The member is done paying for the year.
    const rule = aCoverageRule({
      serviceCode: "HOSPITAL",
      costShare: { type: "coinsurance", rate: 0.5 },
      appliesDeductible: false,
    });
    const line = aLineItem({ serviceCode: "HOSPITAL", billedCents: 60_000 });
    const acc = anAccumulator({ oopMetCents: 300_000 }); // OOP max reached
    const result = adjudicateLine(anAdjudicateInput({ line, rule, acc }));

    expect(result.status).toBe("APPROVED");
    expect(result.memberResponsibilityCents).toBe(0); // member owes nothing more
    expect(result.payableCents).toBe(60_000); // plan pays 100%
    expect(result.deltas.oopIncCents).toBe(0); // nothing more can accrue
    expect(result.reasons).toEqual(["APPROVED", "COINSURANCE_APPLIED", "OOP_MAX_REACHED"]);
  });
});

describe("adjudicateLine — cross-line determinism", () => {
  it("line 2 sees line 1's deductible draw when the caller applies deltas between lines", () => {
    // Two coinsurance lines on one claim. The caller (the claim loop, cycles 22–25) applies
    // each line's deltas to the accumulator BEFORE adjudicating the next. Deductible $500, 20%.
    const rule = aCoverageRule({
      serviceCode: "SURGERY",
      costShare: { type: "coinsurance", rate: 0.2 },
      appliesDeductible: true,
    });
    const accStart = anAccumulator({ deductibleMetCents: 0, oopMetCents: 0 });

    // Line 1 — $300, fully absorbed by the fresh $500 deductible.
    const line1 = aLineItem({ serviceCode: "SURGERY", billedCents: 30_000 });
    const r1 = adjudicateLine(anAdjudicateInput({ line: line1, rule, acc: accStart }));
    expect(r1.deltas.deductibleIncCents).toBe(30_000); // all to deductible

    // Caller advances the accumulator with line 1's deltas.
    const accAfter1 = anAccumulator({
      deductibleMetCents: accStart.deductibleMetCents + r1.deltas.deductibleIncCents, // 30_000
      oopMetCents: accStart.oopMetCents + r1.deltas.oopIncCents,
    });

    // Line 2 — $400. Only $200 of the deductible remains → it draws $200, not a fresh $400.
    const line2 = aLineItem({ serviceCode: "SURGERY", billedCents: 40_000 });
    const r2 = adjudicateLine(anAdjudicateInput({ line: line2, rule, acc: accAfter1 }));

    expect(r2.deltas.deductibleIncCents).toBe(20_000); // proves it saw line 1's advance
    expect(r2.memberResponsibilityCents).toBe(24_000); // $200 deductible + 20% of the other $200
    expect(r2.payableCents).toBe(16_000);
  });

  it("re-running the same line against the same snapshot yields identical results", () => {
    const rule = aCoverageRule({
      serviceCode: "MRI",
      costShare: { type: "coinsurance", rate: 0.2 },
      appliesDeductible: true,
    });
    const line = aLineItem({ serviceCode: "MRI", billedCents: 3_333 }); // odd-cent line
    const acc = anAccumulator({ deductibleMetCents: 20_000 });
    const input = anAdjudicateInput({ line, rule, acc });

    const first = adjudicateLine(input);
    const second = adjudicateLine(input);

    // Pure function: no clock, no RNG, no float drift, no mutation of the input snapshot.
    expect(second).toEqual(first);
  });
});
