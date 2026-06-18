# Self-review

> Status: template. A calibrated gap-list earns more credit than polished completeness.
> Fill the `TBD`s with the truth as the build progresses — including what's rough. The
> reviewer cross-checks this against the code; if it claims more than the code delivers,
> that costs more than an honest gap would.

## What's good

_Fill in as it becomes true. Candidate strengths to claim only when real:_

- Deterministic, explainable adjudication: every decision reproducible from rules + facts + accumulator snapshot. _(verify)_
- Money as integer cents end to end; member + plan shares provably sum to allowed. _(verify with a test)_
- Coverage rules as data, not branches — adding a service is config, not code. _(verify)_
- Two explicit state machines with rejected illegal transitions. _(verify)_
- Tests encode domain behavior (amounts, statuses, reason codes), not HTTP codes — visible in git history as test→feat pairs. _(verify)_

## What's rough

_Be specific. Examples to keep only if accurate:_

- TBD

## What's thin or skipped (and the trade-off)

| Skipped / thin | Why | What it would take |
|---|---|---|
| Out-of-network coverage | In-network is enough to demonstrate the model in 48h | A parallel rule set + network flag on the line item |
| Fee schedule (allowed ≠ billed) | Allowed = billed keeps the math demonstrable | A provider/fee-schedule lookup before step 6 |
| Concurrency / multi-writer | SQLite single-writer is fine for a demo | Row-level locking or a real DB + transaction isolation |
| Prior-auth as a workflow | Modeled as a precondition | A pending→approved/denied sub-state machine |
| TBD | TBD | TBD |

## Confidence calibration

| Area | Confidence | Note |
|---|---|---|
| Adjudication order correctness | TBD | _set after tests cover each step_ |
| Money rounding (coinsurance odd cents) | TBD | _set after the rounding test passes_ |
| State-machine completeness | TBD | _set after transition tests_ |
| Explanation accuracy vs. numbers used | TBD | _set after explanation tests_ |
| Accumulator carry-forward across claims | TBD | _set after the cross-claim test_ |

Legend: High = covered by tests I trust; Medium = works, lightly tested; Low = wired but
under-tested, flagged.

## What I'd do with more time

- Out-of-network rule set and network-aware adjudication.
- A fee schedule so allowed ≠ billed, with the negotiated-rate adjustment explained.
- Property-based tests for the money invariant (member + plan == allowed, never negative, never past OOP max).
- A reviewer queue for disputes instead of auto re-adjudication.
- Richer CARC/RARC mapping for explanation fidelity.
- _add the real ones as they surface._

## Honest one-paragraph summary

_Write this last, at QA. Two to four sentences: what the system genuinely does well, the
single biggest weakness, and what you'd fix first. Match it to reality — this paragraph is
what calibration looks like._
