# Self-review

A calibrated gap-list. The reviewer cross-checks this against the code and the tests; if it
claims more than the code delivers, that costs more than an honest gap would.

## What's good

**Deterministic, explainable adjudication.** The adjudicator is a pure function:
`(line, policy, rule, accumulator snapshot) → decision + deltas`. No I/O, no side effects.
21 unit tests cover every gate (NO_COVERAGE, EXCLUDED, POLICY_NOT_ACTIVE, PRIOR_AUTH_REQUIRED,
LIMIT_EXCEEDED, DUPLICATE_LINE_ITEM) and every cost-share path (full_coverage, copay, coinsurance
with deductible draw, dollar-limit straddle, OOP cap). The cross-line determinism test confirms
that line 2 sees line 1's deductible draw and that re-running against the same snapshot produces
identical output — verifiable in `app/tests/adjudicate-line.test.ts`.

**Integer cents with a provably-satisfied sum invariant.** All money is integer cents. The
coinsurance rounding test explicitly asserts `member + plan === allowed` on an odd-cent remainder —
the one place where float math would silently lose a cent. The invariant holds for every cost-share
path because `plan = allowed − member` is always computed last, never independently.

**Coverage rules as typed config data.** Adding a new service to the system is a single
`INSERT INTO coverage_rules` — zero code changes. The adjudicator is an ordered switch over the
rule's `costShare.type`; the rule record carries all the parameters. This is visible in both the
seed matrix (10 members × up to 3 rules each, zero adjudicator changes) and the test helpers
(rules passed as plain objects to `seedWorld()`).

**Append-only adjudication history.** Adjudications never overwrite. A dispute appends a new row at
a higher `seq` (tested in cycles 27 + 32–36); the original decision is preserved immutably and
surfaced on `GET /claims/:id` as `adjudication_history`. The status-transition log (`status_transitions`
table) is also append-only with a single `setStatus()` chokepoint — the log can never drift from the
status columns because both writes happen in the same DB statement.

**TDD trail visible in git history.** Tests appear before or alongside implementation across 36
numbered cycles. The commit messages follow a `test:` → `feat:` discipline, and the
`app/tests/*.test.ts` files assert domain behavior (amounts, statuses, reason codes, accumulator
deltas) — not just HTTP status codes. Reading the test files top-to-bottom is a readable spec of the
domain rules.

## What's rough

**Duplicate detection is hardcoded `false` at the service layer.** The claim fingerprint
(`memberId + serviceCode + serviceDate + billedCents`) is computed at intake and stored on every line
item. The pure adjudicator accepts an `alreadyAdjudicated: boolean` flag and correctly emits
`DUPLICATE_LINE_ITEM` when it is `true`. But `claimService.adjudicateClaim` hardcodes that flag to
`false` — the cross-claim repo query (`findByFingerprint`) was deferred, so submitting an identical
line a second time does not currently deny it. The structure is in place; the query is a 10-line gap.

**Explanation strings are inlined as template literals.** Each adjudication decision carries a plain
English `explanation` sentence generated inline in the adjudicator. This works and is tested
(HTTP explanation endpoint returns non-empty strings), but the strings are not templated from a
lookup table. Real EOB systems use CARC/RARC code mappings with member-appropriate phrasing. The
current approach is serviceable for a demo; it would need a template layer before it could be
reviewed or localized by a non-engineer.

**Dispute scope is single-line; sibling totals are not recalculated.** When a dispute overturns a
line, the disputed line's payable changes. The claim-level `totalPayableCents` on the response is
recomputed correctly (it aggregates all current decisions). But the accumulator for sibling lines
that were adjudicated before this dispute is not retroactively corrected — documented as a design
decision (decision #16), not a bug, but a real limitation for any scenario where the overturn changes
the accumulator state siblings depend on.

## What's thin or skipped

| Skipped / thin | Why | What it would take |
|---|---|---|
| Duplicate detection (cross-claim) | Fingerprint is stored; the repo query was deferred | `findByFingerprint()` call in `claimService` before adjudication |
| Out-of-network coverage | In-network only; allowed == billed | A parallel OON rule set + network flag on the line item |
| Fee schedule (allowed ≠ billed) | Allowed = billed keeps the math clear in the demo | A provider/fee-schedule lookup step before the cost-share switch |
| Concurrency / multi-writer | SQLite single-writer is fine for a demo | Row-level locking or Postgres + transaction isolation |
| Prior-auth as a sub-workflow | Modeled as a boolean precondition | A pending-auth sub-state machine with an approval queue |
| `PAID` state / settle action | The payable amount is computed; settlement needs a payment gateway | An explicit settle endpoint + `PAID` transition + gateway stub |
| Family / aggregate deductible | Per-member accumulator only | A family-plan link + a shared accumulator ledger |
| CARC/RARC code mapping | Explanation text is inline; real EOBs carry specific codes | A reason-code → CARC/RARC lookup table |

## Confidence calibration

| Area | Confidence | Note |
|---|---|---|
| Adjudication order and gate logic | **High** | 21 unit tests; each gate has its own describe block with an isolation guarantee |
| Money rounding (coinsurance odd cents) | **High** | Explicit test asserts `member + plan === allowed` on an odd-cent remainder |
| State-machine completeness | **High** | Transition log tests (cycles 28–31) cover every status write; `setStatus()` is the only write path |
| Explanation text accuracy | **Medium** | Strings are asserted non-empty and pattern-matched; not independently verified against a template spec |
| Accumulator carry-forward (within a claim) | **High** | Cross-line determinism test (cycles 21–22) confirms line 2 sees line 1's deltas |
| Accumulator carry-forward (cross-claim) | **Medium** | The upsert logic is tested via a single writeback test; no integration test submits two claims sequentially and checks the carry |
| Duplicate line detection (cross-claim) | **Low** | Hardcoded `false` in the service; the pure-function path is tested, the DB-backed path is not |

Legend: **High** = covered by tests I trust; **Medium** = works, lightly tested; **Low** = wired but
under-tested or gapped, flagged.

## What I'd do with more time

1. **Close the duplicate-detection gap.** Add a `findByFingerprint()` repo method and call it in
   `claimService.adjudicateClaim` before adjudication — the path through `adjudicateLine` is already
   implemented and tested; only the DB query is missing.
2. **Property-based tests for the money invariant.** Generate random `billedCents`, `rate`, and
   accumulator snapshots and assert `member + plan === allowed` for all coinsurance combinations and
   OOP-cap crossings.
3. **Sequential cross-claim accumulator test.** Submit claim A, read the accumulators, submit claim B,
   confirm deductible and OOP carry forward correctly.
4. **Out-of-network rule set.** A parallel rule set with a network flag, so the adjudicator can say
   "covered at 50% OON" rather than "NO_COVERAGE".
5. **Fee schedule.** A negotiated-rate lookup so `allowed ≠ billed`, with the adjustment explained in
   the EOB sentence.
6. **CARC/RARC code mapping.** Replace inline explanation strings with a templated lookup table
   reviewable by non-engineers.
7. **Reviewer queue for disputes.** The `DISPUTED_OVERRIDE` enum slot is reserved; a reviewer-approval
   path would layer on the existing dispute state machine without touching the adjudicator.

## Honest one-paragraph summary

The strongest part of the system is the adjudication engine: a pure function, 21 unit tests, provably
deterministic, and covering every gate and cost-share path including the coinsurance rounding edge case.
The integer-cents invariant (`member + plan == allowed`) is tested explicitly, and the append-only audit
trail (adjudications + status-transitions) makes the lifecycle traceable end-to-end. The single biggest
weakness is the missing cross-claim duplicate check: the fingerprint is computed and stored on every line
item, the pure-adjudicator path for `DUPLICATE_LINE_ITEM` is tested, but the service-layer query was
deferred and is hardcoded `false` — a second identical claim currently adjudicates normally instead of
being denied. That is the first thing I would fix.
