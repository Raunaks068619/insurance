---
name: tdd-discipline
description: Load on every coding cycle. Encodes the test-first contract — the red-green-refactor loop, BDD naming, AAA structure with builders, what tests must and must not do, and the commit contract.
---

# TDD discipline skill

Test before code. No production line exists until a failing test demands it. The git
history is graded — red→green commit pairs are the evidence that you drove the design with
tests, not bolted them on after.

## The loop

```
RED      write a failing test that names one behavior
  └─ run vitest, confirm it fails for the RIGHT reason
COMMIT   test: <behavior>            ← test alone, no implementation
GREEN    write the minimum code to pass — nothing the test doesn't demand
  └─ run vitest, confirm green
COMMIT   feat: <behavior>            ← implementation alone
REFACTOR optional; tests stay green
  └─ COMMIT refactor: <what>
LOG      if a decision was made, add a row to TRACK.md
```

One behavior per cycle. Never mix test + implementation in one commit. Never skip red.
Never `--no-verify`.

## BDD naming

Tests are specifications. The name states the behavior, not the method.

| Good | Bad |
|---|---|
| `denies a line item when its service has no coverage rule` | `test NO_COVERAGE` |
| `applies the deductible before coinsurance` | `adjudicate() works` |
| `aggregates to PARTIALLY_APPROVED when some lines deny` | `test partial` |
| `preserves the original adjudication when a line item is disputed` | `dispute test` |
| `pays 100% once the out-of-pocket max is reached` | `oop test` |

Pattern: `<subject> <verb-phrase describing observable behavior> when <condition>`.

## AAA structure with builders

Arrange–Act–Assert, with builder functions so the *relevant* fact of each test stands out
and the irrelevant setup recedes. Builders take partial overrides and fill sane defaults.

```ts
import { describe, it, expect } from "vitest";
import { adjudicate } from "../src/adjudicate";
import { aPolicy, aCoverageRule, aLineItem, anAccumulator } from "./builders";

describe("deductible", () => {
  it("applies the remaining deductible before coinsurance", () => {
    // Arrange
    const policy = aPolicy({ deductibleCents: 50_00, oopMaxCents: 1_000_00 });
    const rule = aCoverageRule({ serviceCode: "OFFICE_VISIT", coinsuranceRate: 0.2 });
    const acc = anAccumulator({ deductibleMetCents: 0, oopMetCents: 0 });
    const line = aLineItem({ serviceCode: "OFFICE_VISIT", billedCents: 200_00 });

    // Act
    const result = adjudicate({ policy, rule, accumulator: acc, line });

    // Assert: 50.00 to deductible, then 20% of remaining 150.00 = 30.00 → member 80.00, plan 120.00
    expect(result.memberResponsibilityCents).toBe(80_00);
    expect(result.payableCents).toBe(120_00);
    expect(result.reasonCode).toBe("DEDUCTIBLE_APPLIED");
  });
});
```

Builders (`aPolicy`, `aCoverageRule`, `aLineItem`, `anAccumulator`, `aClaim`) live in
`app/tests/builders.ts`. Each returns a fully-valid object; the test overrides only what
it is asserting on.

## What tests MUST cover

- **Every reason code** is reachable by at least one test that triggers it.
- **Every state transition** in both machines (claim, line item), including rejected illegal transitions.
- **Partial approval aggregation** — mixed line outcomes roll up correctly.
- **Limit straddling** — payable capped at remaining annual limit; remainder to member.
- **Money math** — deductible/copay/coinsurance/OOP, including odd-cent rounding where member + plan shares must sum to allowed.
- **Idempotency / duplicates** — same fingerprint re-submitted is flagged, original untouched; re-running a claim against the same accumulators yields identical output.
- **Disputes** — reopen re-adjudicates, original adjudication preserved immutably.

## What tests must NOT do

- No spying on internal/private methods. Test observable behavior through the public surface (`adjudicate`, the endpoints).
- No shared mutable state between tests. Each test builds its own world via builders.
- No `any` types in tests. Strict types are part of the spec; `any` hides bugs the test exists to catch.
- No asserting only HTTP status codes or return *types*. Assert domain outcomes (amounts, statuses, reason codes).

## Commit message contract

| Prefix | Use |
|---|---|
| `test:` | A new failing test (committed before its implementation). |
| `feat:` | The implementation that makes a test pass. |
| `refactor:` | Behavior-preserving change; tests already green. |
| `chore:` | Scaffolding, config, JSONL persistence, deps. |
| `docs:` | Documentation only. |

## When to break the rule

Rare, justified, logged. Acceptable: spiking to learn an API (then delete the spike and
redo test-first), or a pure-config/scaffolding change with no behavior. If you write
production behavior without a prior failing test, say so in the commit body and add a
`TRACK.md` note explaining why. Unlogged after-the-fact tests are an auto-reject signal.
