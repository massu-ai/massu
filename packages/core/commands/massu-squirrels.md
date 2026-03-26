---
name: massu-squirrels
description: "When user has a tangential idea mid-task that should be parked — 'squirrel this', 'park this idea', 'remind me later about'"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-squirrels

# Massu Squirrels: Idea Parking Lot Manager

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-14, CR-5, CR-12 enforced.

---

## Purpose

Manage `.claude/session-state/squirrels.md` — a parking lot for stray ideas that come up mid-session. These are thoughts worth capturing but not worth derailing the current task for.

**This is NOT a backlog.** It's a scratchpad. Ideas here are unvetted, unscoped, and may be irrelevant. The value is in not losing them.

---

## ARGUMENTS

```
/massu-squirrels                     # Show current squirrels list
/massu-squirrels add [idea]          # Park a new idea
/massu-squirrels review              # Review all ideas, grouped by age
/massu-squirrels promote [N]         # Promote idea #N to a plan or task
/massu-squirrels clean               # Remove stale/irrelevant ideas
```

**Arguments from command**: `{{ARGUMENTS}}`

---

## Actions

### No argument / `review` — Show current squirrels

1. Read `.claude/session-state/squirrels.md`
2. If empty (no ideas below the divider): say "No parked squirrels." and stop
3. If ideas exist, display them grouped by age:
   - **Fresh** (today or yesterday)
   - **This week** (2-7 days old)
   - **Aging** (> 7 days — consider promoting or cleaning)
4. Show count: "N squirrels parked (X fresh, Y aging)"

### `add` — Park a new idea

1. Determine the idea from `{{ARGUMENTS}}` (everything after "add")
2. Determine current context from `session-state/CURRENT.md` (what task is active)
3. Append to `.claude/session-state/squirrels.md`:
   ```
   - YYYY-MM-DD: [idea] (context: [current task summary])
   ```
4. Confirm: "Parked: [idea]"
5. Return to current work — do NOT expand on the idea or start working on it

### `promote [N]` — Promote an idea

1. Read squirrels.md, number the ideas (1-based, top to bottom)
2. Display idea #N and ask: "Promote this to a plan, a task, or a session-state item?"
3. Based on response:
   - **Plan**: Create a plan stub in the project docs plans directory
   - **Task**: Add to CURRENT.md as an open item
   - **Session-state**: Add to CURRENT.md as context
4. Remove the idea from squirrels.md
5. Confirm: "Promoted squirrel #N to [destination]"

### `clean` — Clean stale ideas

1. Read squirrels.md, display ALL ideas with numbers
2. Ask user which to remove (by number, or "all aging" for ideas > 7 days old)
3. Remove selected ideas
4. Confirm: "Cleaned N squirrels. M remaining."

---

## Integration Points

- `/massu-bearings` reads squirrels.md and surfaces the count + list
- `/massu-recap` surfaces any squirrels added during the session
- Squirrels are NOT automatically promoted — they require explicit user action
- Squirrels are NOT persisted to memory/ — they are ephemeral by design

---

## Edge Cases

- If `squirrels.md` doesn't exist: create it with the standard header format
- If `CURRENT.md` doesn't exist when adding context: use "no active task" as context
- If promote target #N doesn't exist: show the list and ask again

---

## START NOW

1. Parse `{{ARGUMENTS}}` to determine action (show/add/review/promote/clean)
2. Read `.claude/session-state/squirrels.md`
3. Execute the appropriate action
4. Return to current work without expanding on the idea
