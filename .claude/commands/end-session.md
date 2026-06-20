---
description: Session-close ritual — update TRACK.md, persist this session's JSONL into JSONL_session_logs/{phase}/, commit.
---

# /end-session

Close the session cleanly so the next agent loses nothing and the JSONL audit trail stays
complete. The JSONL copy is mandatory — a commit without it is a process failure.

## 1. Update `TRACK.md`

- Append a row to the **Session log** table: `Date | Agent | Phase | Outcome | Next`.
- Update **Current focus** to the next concrete step.
- Update **Current phase** if it changed.
- Resolve any **Open questions** that got answered (check the box, note the resolution).
- Add rows to the **Decisions log** for any decisions made this session.

## 2. Locate this session's JSONL

- **Claude Code:** `~/.claude/projects/{project-hash}/{session-id}.jsonl`
  Find the active project dir and newest log:
  ```bash
  ls -dt ~/.claude/projects/*/ | head
  ls -t ~/.claude/projects/<project-hash>/*.jsonl | head
  ```
- **Codex CLI:** `~/.codex/sessions/` — newest `.jsonl`.

## 3. Copy it into the current phase folder

Filename pattern: `{YYYY-MM-DD}_{agent}_{short-description}.jsonl`

```bash
cp <source>.jsonl JSONL_session_logs/<current-phase>/2026-06-18_claude_<short-description>.jsonl
```

Examples of `<agent>`: `claude`, `codex`, `cursor`. `<current-phase>` is one of
`01-framing` … `07-qa`.

## 4. Commit

```bash
git add -A
git commit -m "chore: <phase> session — <short outcome>, JSONL logged"
```

Verify the JSONL is staged in the commit before finishing.

## Forbidden in this command

- Editing `PRD.md` (scope is locked).
- Deleting or rewriting existing session-log rows (append only).
- Committing without copying this session's JSONL into `JSONL_session_logs/{phase}/`.
