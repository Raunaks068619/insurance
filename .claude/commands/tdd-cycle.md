---
description: Red-green-refactor enforcer for one behavior. Usage — /tdd-cycle "denies a line item with no coverage rule"
argument-hint: "<behavior in plain English>"
---

# /tdd-cycle

Drive one behavior, test-first. The behavior is `$ARGUMENTS`.

If `$ARGUMENTS` is empty, stop and ask for the behavior in plain English before doing
anything.

## Steps

1. **Write the failing test.** In `app/tests/`, write one test named for `$ARGUMENTS`
   (BDD style, AAA structure, builders from `tests/builders.ts`). It must assert a domain
   outcome (amount / status / reason code), not a type or HTTP status.
2. **Run vitest. Confirm RED.**
   ```bash
   pnpm test
   ```
   The test must fail for the *right* reason (the behavior is missing), not a typo or
   import error. If it fails for the wrong reason, fix the test first.
3. **Commit the test alone.**
   ```bash
   git add app/tests && git commit -m "test: $ARGUMENTS"
   ```
4. **Write the minimum implementation** in `app/src/` to make it pass. Add nothing the
   failing test does not require — no extra branches, no speculative params.
5. **Run vitest. Confirm GREEN.**
   ```bash
   pnpm test
   ```
6. **Refactor if warranted** (naming, duplication) with tests staying green.
7. **Commit the implementation.**
   ```bash
   git add app/src && git commit -m "feat: $ARGUMENTS"
   ```
   (Separate `refactor:` commit if you refactored.)
8. **If a decision was made**, add a row to the `TRACK.md` decisions log.

## Forbidden

- Mixing test and implementation in one commit.
- Skipping the red step (you must see it fail first).
- Adding behavior the failing test does not require.
- `git commit --no-verify`.
