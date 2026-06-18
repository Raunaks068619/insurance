# AGENTS.md — cross-agent source of truth

Every agent working this repo (Claude Code, Codex CLI, Cursor) reads this file first.
It is the single source of truth for rules and process. `CLAUDE.md` is a pointer here —
do not duplicate rules across both. If a rule changes, it changes here.

## Mission

Build a Claims Processing System for health insurance: accept claim submissions with
line items, adjudicate each line against coverage rules, track claim and line-item
lifecycles, and produce a human-readable explanation for every decision. Members can
dispute a line-item decision. The system is judged on domain modeling, rule
representation, state management, edge-case thinking, explanation quality, test-first
git history, and honest self-review — not on feature count.

## Read order at session start

1. `AGENTS.md` (this file) — rules and process
2. `PRD.md` — locked scope and the done-state definition
3. `TRACK.md` — current focus, open questions, decisions log, where the last agent stopped
4. `docs/domain-model.md` — entities and state machines as currently modeled

Then run `git status` and `git log --oneline -10` to ground yourself in the actual tree.
Use the `/start-session` command to do this ritual in order.

## Hard rules (non-negotiable)

1. **TDD is non-negotiable.** No production code without a failing test that demands it.
   Red → commit `test:` → green → commit `feat:`. One behavior per cycle. See
   `.claude/skills/tdd-discipline/SKILL.md` and `/tdd-cycle`.
2. **Scope is locked by `PRD.md`.** The in-scope list and out-of-scope list are frozen.
   Building anything on the out-of-scope list is an auto-reject. If scope feels wrong,
   stop and raise it — do not silently expand.
3. **Session ritual is mandatory.** Every session opens with `/start-session` and closes
   with `/end-session`. Closing a session without copying the JSONL into
   `ai-artifacts/{phase}/` is a process failure — the JSONL is a graded deliverable.
4. **JSONL belongs in `ai-artifacts/{phase}/`.** Every phase (framing, domain research,
   design, coding, testing, docs, QA) must have at least one raw `.jsonl` log. No JSONL =
   submission rejected. Markdown summaries do not substitute.
5. **Money is integer cents.** Never floats for money. Ever.
6. **No code on the out-of-scope list**, no speculative abstraction, no DSL. Typed
   config over a rules engine. See anti-patterns below.

## Stack (with one-line reasons)

| Choice | Reason |
|---|---|
| TypeScript (strict) + Node 20 | Static types encode the domain; strict catches money/null bugs at compile time. |
| vitest | Fast, native ESM/TS, first-class for the test-first loop. |
| fastify | Minimal, typed, fast HTTP for 4 endpoints — no framework ceremony. |
| SQLite (better-sqlite3) | Zero-setup persistence; reviewer clones and runs with no DB server. Synchronous API keeps adjudication deterministic. |
| biome | One tool for lint + format; no eslint/prettier config sprawl. |
| pnpm | Fast, disk-efficient, deterministic installs. |

## File map

```
AGENTS.md                     # this file — rules and process
CLAUDE.md                     # 2-line pointer here
PRD.md                        # locked scope, done-state, interface, domain primer
TRACK.md                      # live cross-session memory (the only file that mutates freely)
README.md                     # human-facing setup + demo curls
.claude/
  commands/
    start-session.md          # session open ritual
    end-session.md            # session close + JSONL persistence
    tdd-cycle.md              # red-green-refactor enforcer
  skills/
    insurance-domain/SKILL.md # entities, terminology, reason codes, adjudication order
    tdd-discipline/SKILL.md   # the test-first contract
app/
  src/                        # production code
  tests/                      # tests (written first)
docs/
  domain-model.md             # deliverable: entities, state machines, aggregation
  decisions.md                # deliverable: what/why/skipped, assumptions
  self-review.md              # deliverable: honest gap-list
ai-artifacts/
  README.md                   # map of the JSONL audit trail
  01-framing/ … 07-qa/        # raw .jsonl per phase
project-docs/                 # the original assignment brief (reference, do not edit)
```

## When to invoke system skills

| Phase | Skill | Why |
|---|---|---|
| 01 framing | `/product-management:brainstorm` | Pressure-test scope and open questions before any modeling. |
| 03 design | `/engineering:testing-strategy` | Decide what the test suite must encode before writing code. |
| 07 QA | `/engineering:code-review` | Independent review pass before declaring done. |

Explicitly **NOT** `/design:design-system` — there is no UI design surface in this
assignment. The interface is a REST API for demonstration only.

Also load the project skills when relevant: `insurance-domain` whenever naming or
modeling anything in the domain; `tdd-discipline` on every coding cycle.

## The TDD cycle

1. Write a failing test in `app/tests/` that names a behavior in plain English.
2. Run vitest. Confirm it fails for the right reason (RED).
3. Commit the test alone: `test: <behavior>`.
4. Write the minimum code in `app/src/` to pass — nothing the test does not demand.
5. Run vitest. Confirm GREEN.
6. Commit the implementation: `feat: <behavior>`.
7. Refactor if warranted; tests stay green; commit `refactor:`.
8. If the cycle produced a decision, log it in `TRACK.md`.

Driven by `/tdd-cycle <behavior>`. Never mix test and implementation in one commit.
Never skip the red step. Never `--no-verify`.

## The session ritual

- **Open:** `/start-session` — read the four files in order, run git status/log, declare
  session intent (phase, focus, reads, open questions), confirm the TDD rule verbatim.
- **Close:** `/end-session` — append a session-log row to `TRACK.md`, update current
  focus, log any decisions, copy this session's `.jsonl` into `ai-artifacts/{phase}/`,
  commit with a `chore:` message.

## What "done" means per deliverable

| Deliverable | Done when |
|---|---|
| `app/` | All 4 endpoints work; adjudication is deterministic; every reason code reachable; tests green; runs from a clean clone via README. |
| `docs/domain-model.md` | Entities, both state machines, aggregation logic, and rule shape documented and matching the code. |
| `docs/decisions.md` | Every non-obvious choice has a stated trade-off; assumptions explicit. |
| `docs/self-review.md` | Calibrated gap-list: what's thin, what's skipped, why, and what you'd do next. Matches reality. |
| `ai-artifacts/` | At least one raw `.jsonl` per phase folder 01–07. |
| `README.md` | A reviewer can clone, install, seed, test, and run without asking a question. |

## Anti-patterns (auto-reject)

- A rules DSL or pluggable rules engine. Coverage rules are typed config. The 48h budget
  buys correctness, not a meta-language.
- Floating-point money. Use integer cents everywhere.
- Hardcoded rules buried in adjudication branches instead of data-driven coverage rules.
- A single `status` string field with magic transitions and no state machine. Model claim
  and line-item lifecycles as explicit machines with validated transitions.
- Tests written after the code, or tests that only assert HTTP status codes / return types
  instead of domain behavior.
- Building anything on the out-of-scope list (auth, CRUD, notifications, dashboards,
  multi-tenancy, RBAC).
- Accepting a wall of AI-generated code without review. You own every line; you must be
  able to walk through it.
