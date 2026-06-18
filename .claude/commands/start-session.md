---
description: Session-open ritual — read context in order, ground in git, declare intent, confirm the TDD rule.
---

# /start-session

Do this in order. Do not skip a read. Do not write code in this command.

## 1. Read context (in this exact order)

1. `AGENTS.md` — rules and process
2. `PRD.md` — locked scope and done-state
3. `TRACK.md` — current focus, open questions, decisions, where the last agent stopped
4. `docs/domain-model.md` — current entities and state machines

## 2. Ground in the actual tree

Run and read the output:

```bash
git status
git log --oneline -10
```

## 3. Declare session intent

Print exactly this block, filled in:

```
Session start
Phase:          <e.g. 02-domain-research>
Focus:          <one line, taken from TRACK.md Current focus>
Reads:          AGENTS.md, PRD.md, TRACK.md, docs/domain-model.md  (✓ done)
Open questions: <list the unresolved checkboxes from TRACK.md, or "none">
```

## 4. Confirm the TDD rule verbatim

Print:

```
TDD rule confirmed: no production code without a failing test that demands it.
Red → commit test: → green → commit feat: → refactor:. One behavior per cycle.
```

## Forbidden in this command

- Writing or editing any code in `app/`.
- Modifying `TRACK.md` (that happens at `/end-session`).
- Skipping any of the four reads or the git grounding.
