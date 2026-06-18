# CLAUDE.md

Read `AGENTS.md` first — it is the source of truth for mission, rules, stack, and
process. Do not duplicate or restate its rules here; this file only points to it.

- Model preference: Opus for design, domain modeling, and review; Sonnet for coding cycles.
- Start every session with `/start-session`; end with `/end-session` (persists JSONL).
- Default loop: `/tdd-cycle "<behavior>"`. TDD is non-negotiable — test before code.
- Default commands: `pnpm install`, `pnpm seed`, `pnpm test`, `pnpm dev`.
