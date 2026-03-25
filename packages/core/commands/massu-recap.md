---
name: massu-recap
description: "When user says 'done for today', 'wrapping up', 'end session', 'handoff', or is about to close the terminal"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-recap

# Massu Recap: Session Handoff

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding.

---

## Purpose

Answer one question: **"What happened this session and what does the next session need to know?"**

This command captures the current session's work, updates session state, and ensures nothing is lost before the session ends. It is the counterpart to `/massu-bearings` — recap writes the handoff note that bearings reads tomorrow.

**Privilege level**: Level 1.5 (reads state + writes to session-state files only, no code changes).

---

## Data Sources

Read these to build the session summary:

| # | Source | What to extract |
|---|--------|----------------|
| 1 | `session-state/CURRENT.md` | What was planned, active task |
| 2 | `git log --since="6am" --oneline` | Commits made this session |
| 3 | `git diff --stat` | Uncommitted changes |
| 4 | `session-state/squirrels.md` | Ideas parked during session |
| 5 | `.claude/plans/*.md` | Plan progress (items completed vs total) |
| 6 | `memory/MEMORY.md` | Whether memory was updated this session |

---

## Actions (Execute in Order)

### Step 1: Generate Session Summary

Present to terminal:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECAP — [date]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WHAT GOT DONE
  - [commit hash] [message]
  - [commit hash] [message]
  - [non-committed work: files changed, what was done]
  (or "No commits this session")

WHAT'S STILL OPEN
  - [incomplete item 1 — status/progress]
  - [incomplete item 2]
  (or "All planned work completed")

NEW DISCOVERIES
  - [issue found but not yet addressed]
  - [pattern violation noticed]
  (or "None")

SQUIRRELS ADDED ([N] new)
  - [idea 1]
  (or "No new squirrels this session")

UNCOMMITTED CHANGES
  [git diff --stat output or "Working tree clean"]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Step 2: Memory Persistence Check

Check whether significant work was done this session:

| Signal | Indicates significant work |
|--------|---------------------------|
| Commits made | Yes |
| Plan items completed | Yes |
| Bugs fixed | Yes |
| New patterns discovered | Yes |
| User corrections received | Yes |
| Architecture decisions made | Yes |

If significant work detected:
```
MEMORY CHECK
  Significant work detected: [list signals]
  Memory updated this session: YES / NO

  [If NO]: You should persist key learnings to memory/ before ending.
  Suggested memory writes:
    - [topic]: [what to record]
```

If no significant work: skip this section.

### Step 3: Update Session State

Update `session-state/CURRENT.md` with:
- Final status of the session's work
- Any open items carrying forward
- Failed approaches (if any)
- Next steps for the next session

### Step 4: Archive Decision

If the active task in CURRENT.md is fully complete:
- Ask user: "Task [name] appears complete. Archive session state? (yes/no)"
- If yes: `mv session-state/CURRENT.md session-state/archive/YYYY-MM-DD-[desc].md`
- Create fresh CURRENT.md for next session
- If no: leave CURRENT.md as-is

If the task is still in progress:
- Do NOT archive — just update CURRENT.md with current state
- Do NOT ask about archiving

---

## What Recap Does NOT Do

- Does NOT commit code (use `/massu-commit`)
- Does NOT push to remote (use `/massu-push`)
- Does NOT modify source code or configuration
- Does NOT auto-promote squirrels (that requires explicit `/massu-squirrels promote`)
- Does NOT write to memory/ files directly (it reminds you to, but doesn't do it for you)

---

## Edge Cases

- **No CURRENT.md**: Create one with the session summary as the initial content
- **No commits today**: Focus on uncommitted changes and discoveries
- **No squirrels.md**: Skip the squirrels section
- **Multiple sessions in one day**: Use `git log --since="6am"` to capture the current session (adjust if user started later)
- **Session was just reading/research**: Still worth a recap — record what was learned and any decisions made

---

## Recap History

After presenting the recap output, append a JSONL line to `.claude/metrics/recap-history.jsonl`:

```json
{"timestamp":"ISO","session_duration_approx":"3h","commits":2,"plans_completed":1,"incidents":0,"memories_written":3}
```

On next recap, read last 3 entries from `recap-history.jsonl` to compare session productivity. If no history file exists, skip comparisons.

---

## START NOW

1. Read all data sources in parallel
2. Generate and present the session summary
3. Run the memory persistence check
4. Update CURRENT.md with final state
5. Append recap-history.jsonl entry
6. If task is complete, ask about archiving
7. Confirm: "Recap complete. Ready for next session."
