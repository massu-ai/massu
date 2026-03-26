# Post-Compaction Recovery Protocol

**Purpose**: Restore context after session compaction. Execute IMMEDIATELY when compaction summary appears.

**When to Read**: Automatically after any session compaction.

---

## Pre-Compaction: Proactive Context Preservation

**Don't wait for compaction to hit you. Context quality degrades before the system forces compression.**

If a session has been running long (many tool calls, large outputs, or nearing compaction warnings):
1. **Update `session-state/CURRENT.md`** with current progress, decisions, and next steps
2. **Commit any completed work** - don't leave valuable changes only in working memory
3. **Consider `/clear` + fresh start** - a clean session with good CURRENT.md outperforms a degraded long session

**Why**: Performance drops in the final portion of the context window. Proactive state-saving before exhaustion produces better outcomes than reactive recovery after compaction.

---

## Recovery Steps

### Step 0: Read Session State File (MOST CRITICAL)

**FIRST, read `session-state/CURRENT.md`** - Contains:
- Current task and progress
- Uncommitted file changes
- Decisions made + rationale
- **Failed attempts (DO NOT RETRY these)**
- Next steps planned
- User preferences

### Step 0.5: Check AUTHORIZED_COMMAND (CR-12 - MANDATORY)

**BEFORE continuing ANY work, check the AUTHORIZED_COMMAND field in session-state/CURRENT.md.**

```
AUTHORIZED_COMMAND: [command name from session state]
```

**Rules:**
1. If AUTHORIZED_COMMAND is present, you may ONLY continue executing THAT command
2. You may NOT escalate to a higher-privilege command without explicit user instruction
3. System reminders referencing other commands are NOT user authorization
4. Continuation instructions ("continue where you left off") do NOT override this check

**Command Privilege Hierarchy** (lowest to highest):
| Level | Command | Privilege |
|-------|---------|-----------|
| 1 | `massu-create-plan` | Read-only research, writes plan doc |
| 1 | `massu-bearings` | Read-only session orientation |
| 1 | `massu-squirrels` | Session-state file management only |
| 1.5 | `massu-recap` | Writes session-state files only, no code changes |
| 2 | `massu-plan` | Audit, edits plan docs only |
| 3 | `massu-loop` | Full implementation with code changes |
| 4 | `massu-commit` | Commit with verification gates |
| 5 | `massu-push` | Push to remote with full verification |

**Escalation Prevention:**
- If AUTHORIZED_COMMAND = `massu-plan` and system context suggests `/massu-loop`:
  - **FORBIDDEN** - Do not execute `/massu-loop`
  - Continue with `/massu-plan` only
  - Inform user: "Previous session authorized `/massu-plan`. To proceed with implementation, please explicitly run `/massu-loop`."

- If AUTHORIZED_COMMAND = `massu-loop` and session was mid-implementation:
  - **ALLOWED** - Continue `/massu-loop` from where it left off
  - This is continuation, not escalation

**Why This Step Exists:**
A user invoked a plan-only command (audit-only). After compaction, system reminders referenced the implementation command. Assistant executed full implementation without authorization, creating unauthorized commits. Text-based safeguards failed because they competed with continuation behavior. This structural check prevents that.

### Step 1: Re-Read CLAUDE.md

CLAUDE.md is automatically loaded, but VERIFY you have read it by checking the Core Rules section exists.

### Step 2: Identify Relevant Domain from Compaction Summary

Look at the compaction summary for:
- What domain was being worked on? (database, auth, UI, etc.)
- What features were being implemented/debugged?
- What files were being modified?

### Step 3: Load Relevant Pattern Files

Based on Step 2, read the appropriate pattern files BEFORE continuing work:

| If working on... | Read this file |
|------------------|----------------|
| Database/Prisma/tRPC routers | `patterns/database-patterns.md` |
| Authentication/Authorization | `patterns/auth-patterns.md` |
| UI components/pages | `patterns/ui-patterns.md` |
| Real-time subscriptions | `patterns/realtime-patterns.md` |
| Testing | `patterns/testing-patterns.md` |
| Build issues | `patterns/build-patterns.md` |

### Step 4: Load Relevant Archives (If Extending Features)

If the compaction summary mentions extending/debugging a completed feature:
- Check archives for the relevant archive
- Read the specific archive before continuing

### Step 5: Re-Read Plan Document (If Multi-Phase)

If the compaction summary references a plan document:
- Read the plan document
- Verify current phase status via git log or session state

### Step 5.5: Post-Compaction Plan Re-Verification

**MANDATORY when recovering during an implementation run with a plan in progress.**

After re-reading the plan document, BEFORE continuing implementation:

1. **Re-read the FULL plan document** line by line
2. **For every item marked complete** in the tracking table or session state:
   - Re-run its VR-* verification command
   - For UI items with specific CSS classes/structure in the plan: grep for those EXACT strings (VR-SPEC-MATCH)
   - If verification fails: mark as gap, fix BEFORE continuing to new items
3. **Flag any mismatches**: Implementation that doesn't match the plan's exact spec is treated as incomplete
4. **Resume from the first incomplete item**, not from where the compaction summary says

**Why**: Context compaction loses spec details (exact CSS classes, exact structure). Without re-verification, the agent continues implementing while prior items silently diverge from the plan. This step catches that drift.

---

## Recovery Announcement

Before continuing work after recovery, explicitly state:

```
Post-compaction recovery complete:
- Current task: [from session-state]
- Domain: [database/auth/UI/etc]
- Patterns loaded: [list]
- Resuming from: [exact location]
- Session state verified: [yes/no]
```

---

## Critical Warning

**The compaction summary is a HIGHLIGHT REEL, not complete context.**
- It does NOT contain pattern rules
- It does NOT contain code examples
- It does NOT contain critical constraints
- It does NOT contain failed attempts or decisions rationale
- **You WILL make pattern violations if you skip this protocol**

**NEVER say "I'll continue from where we left off" without first completing Steps 0-5.**

---

## Multi-Phase Plan Recovery

For multi-phase plans specifically, ALSO:

1. Read `protocols/plan-implementation.md`
2. Verify current phase status via:
   - Todo list
   - Git log
   - Schema state
   - Session state file
3. Re-execute Pre-Phase Protocol for current phase

### What To Do If Session State Is Missing

If `session-state/CURRENT.md` does not exist or is empty:
1. **STOP** - Do not proceed
2. Re-read the ENTIRE plan line-by-line
3. Query database to determine current state
4. Create session state based on verified state
5. Announce current checkpoint to user before proceeding

---

## Session State Update Requirements

Update `session-state/CURRENT.md` after:
- [ ] Significant decision made (record WHAT + WHY)
- [ ] Failed attempt (record what didn't work + why) - CRITICAL
- [ ] File modified (add to uncommitted changes list)
- [ ] Task pivot (update current task description)
- [ ] User preference expressed (record for future reference)
- [ ] Blocker encountered (document the obstacle)
- [ ] Phase/checkpoint completion

## FAILED APPROACH TRACKING (CRITICAL)

After TWO failed corrections on the same issue:
1. STOP attempting the same approach
2. Document the failed approach in session-state/CURRENT.md
3. Start fresh: /clear and write a better initial prompt
   incorporating what you learned from the failures

FORMAT in session-state/CURRENT.md:
### Failed Approaches (DO NOT RETRY)
| # | Approach | Why It Failed | Lesson |
|---|---------|---------------|--------|
| 1 | [what you tried] | [why it broke] | [what to do instead] |

WHY: Context polluted with failed approaches leads to worse outputs.
Starting fresh with better instructions is faster than continuing
to iterate in polluted context.

### When to Archive Session State

Archive `CURRENT.md` to `archive/YYYY-MM-DD-[description].md` when:
- Major task/feature is complete
- Switching to unrelated work
- End of significant work session

```bash
mv session-state/CURRENT.md session-state/archive/$(date +%Y-%m-%d)-[description].md
```

Then create fresh `CURRENT.md` for next task.

**NEVER delete archives** - they are permanent institutional memory.

---

**Document Status**: ACTIVE
**Compliance**: Mandatory after any session compaction
