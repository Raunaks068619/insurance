# ai-artifacts — the JSONL audit trail

Raw `.jsonl` session logs from the coding agents, one folder per phase. These are a
**mandatory, graded deliverable**: submissions without complete JSONL logs covering every
phase are rejected. Curated Markdown summaries, `.json` array dumps, and screenshots do
**not** substitute — only raw `.jsonl` separates the human's contribution from the agent's.

## Phase folders

| Folder | Phase | What it should contain |
|---|---|---|
| `01-framing/` | Problem framing | Scope lock, open-question resolution, the conversation that set direction. |
| `02-domain-research/` | Domain research | Insurance terminology, denial taxonomy, adjudication logic research → `domain-model.md` draft. |
| `03-design/` | Design | Schema, adjudicator interface, test strategy (`/engineering:testing-strategy`). |
| `04-coding/` | Implementation | The red-green-refactor cycles building the system. |
| `05-testing/` | Testing | Edge-case tests, money-math tests, verification runs. |
| `06-docs/` | Documentation | Finalizing domain-model / decisions / self-review against the code. |
| `07-qa/` | QA | Code review (`/engineering:code-review`), final run-through, fixes. |

Every folder must hold **at least one** `.jsonl` before submission.

## File naming convention

```
{YYYY-MM-DD}_{agent}_{short-description}.jsonl
```

Examples:
- `2026-06-18_claude_framing-scope-lock.jsonl`
- `2026-06-19_codex_adjudicator-tdd.jsonl`
- `2026-06-19_claude_money-rounding-tests.jsonl`

`{agent}` is one of `claude`, `codex`, `cursor`.

## Where each agent's JSONL lives on disk

| Agent | Location |
|---|---|
| Claude Code | `~/.claude/projects/{project-hash}/{session-id}.jsonl` |
| Codex CLI | `~/.codex/sessions/` |

Find the newest Claude Code log:

```bash
ls -dt ~/.claude/projects/*/ | head        # find the project hash dir
ls -t ~/.claude/projects/<hash>/*.jsonl | head   # newest session log
```

`/end-session` copies the current session's log into the right phase folder automatically.

## What goes in JSONL vs. not

- **In:** the raw, unedited session transcript the agent wrote — prompts, tool calls, the
  model's responses, corrections. This is the process evidence.
- **Not in:** hand-curated summaries, redacted/reformatted exports, `.json` arrays, images.
  Keep those out of these folders; they don't count and dilute the trail.

## Pre-submission check

Confirm every phase has at least one log before you zip:

```bash
for d in ai-artifacts/0*/; do
  n=$(find "$d" -name '*.jsonl' | wc -l | tr -d ' ')
  echo "$d -> $n jsonl"
done
```

Every line must show `-> 1` or more. Any `-> 0` is a blocker — that phase is
unrepresented and the submission would be rejected.
