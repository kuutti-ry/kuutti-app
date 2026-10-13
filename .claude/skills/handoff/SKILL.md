---
name: handoff
description: Write .claude/session-handoff.md so the next session can continue after /clear. Use before the user clears, when a task or issue is finished, or before a long pause. Records goal, state, files touched, decisions, next steps, and how to verify.
argument-hint: [optional note for the next session]
allowed-tools: Bash(git *), Bash(gh *), Read, Write
---

Write `.claude/session-handoff.md` at the repository root, overwriting it. It is gitignored and injected into context by a SessionStart hook after `/clear`, `/compact`, and on startup, so it must be short: under 60 lines, facts only, no narrative.

Gather first, do not guess: `git log --oneline -8`, `git status --short`, the open issue being worked on (`gh issue list --state open` if unsure), and the last verification commands that were run.

Use exactly this shape:

```markdown
# Session handoff — <YYYY-MM-DD HH:MM local>

## Goal
<one sentence: the task in progress or just finished, with its issue number>

## State
- main at <short sha> "<subject>"; <clean | N uncommitted files: list them>
- <what is running locally, if anything: env:up, containers, servers, or "nothing running">
- <issue status: #N open with items X unticked | #N closed>

## Files touched this session
- <path> — <what changed, five words>

## Decisions made (and why)
- <decision> — <reason, one clause>

## Next steps
1. <the next concrete action, with the command or file>
2. ...

## Verify
- `<command>` → <expected output>

## Gotchas
- <anything that cost time this session and would again>

<the optional note passed as the argument, if any>
```

Rules: put nothing secret in it (no tokens, passwords, connection strings with real credentials). Refer to memories and issues by name, do not copy them in. When done, tell the user the handoff is written and it is safe to `/clear`.
