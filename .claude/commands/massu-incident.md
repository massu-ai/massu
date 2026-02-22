---
name: massu-incident
description: Automated incident post-mortem with prevention pipeline
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Massu Incident: Automated Post-Mortem & Prevention Pipeline

## Objective

When a bug is discovered that an audit should have caught, execute a
structured post-mortem that AUTOMATICALLY:
1. Logs the incident to INCIDENT-LOG.md
2. Records it in session state (high importance)
3. Proposes a new CR rule or VR-* check
4. Proposes a pattern-scanner addition
5. Updates relevant protocol files with incident reminder

## INPUT

User provides: description of what went wrong and how it was discovered.

---

## STEP 1: CAPTURE INCIDENT DETAILS

Gather from user and investigation:

```markdown
### Incident Capture
- **What happened**: [user-visible bug]
- **Root cause**: [why it happened]
- **Discovery**: USER / AUDIT / AUTOMATED
- **Impact**: [what broke, who was affected]
- **Files involved**: [list]
- **Which audit should have caught this**: [massu-plan / massu-loop / massu-commit / etc.]
- **Why the audit missed it**: [specific reason]
```

## STEP 2: DETERMINE NEXT INCIDENT NUMBER

```bash
grep -c "^## Incident #" .claude/incidents/INCIDENT-LOG.md
# Next number = count + 1
```

## STEP 3: LOG TO INCIDENT-LOG.md

Append to `.claude/incidents/INCIDENT-LOG.md`:

```markdown
## Incident #[N]: [Short Title]

**Date**: [YYYY-MM-DD]
**Severity**: CRITICAL / HIGH / MEDIUM
**Discovery**: USER / AUDIT / AUTOMATED
**Root Cause**: [description]
**Files Involved**: [list]
**What Should Have Caught It**: [audit/protocol name]
**Why It Was Missed**: [reason]
**Prevention Added**: [CR-XX / VR-XX / pattern-scanner rule]
**Lesson**: [one-line lesson]
```

## STEP 4: RECORD IN SESSION STATE

Update `session-state/CURRENT.md` with incident details:
```markdown
### INCIDENT #[N]: [short title]
- **Type**: failed_attempt
- **Root cause**: [root cause and lesson]
- **Importance**: 5 (critical)
- **CR rule**: [relevant CR]
- **Files involved**: [file list]
```

This ensures the incident surfaces in future sessions via session state review.

## STEP 5: PROPOSE PREVENTION

### 5a: New CR Rule (if pattern is new)
If the failure mode isn't covered by existing CRs:
- Propose CR-[N+1] with rule text
- Add to CLAUDE.md CR table
- Add to Zero Tolerance table

### 5b: New VR-* Check (always)
Every incident MUST produce a verifiable check:
- Define the verification command
- Add to VR table in CLAUDE.md
- Specify when to run it

### 5c: Pattern Scanner Rule (if automatable)
If the failure can be caught by grep:
- Add rule to `scripts/massu-pattern-scanner.sh`
- Test it catches the original failure
- Verify it doesn't false-positive

### 5d: Protocol Update (always)
Add incident reminder to the protocol that should have caught it:
- Add `## INCIDENT #[N] REMINDER` section
- Explain the failure mode
- Explain what to check for

## STEP 6: UPDATE CLAUDE.md INCIDENT SUMMARY

Update the incident count and add the new row to the incident table.

## STEP 7: VERIFY PREVENTION WORKS

```bash
# If pattern-scanner rule added:
bash scripts/massu-pattern-scanner.sh

# If VR-* check added, run it:
[verification command]
```

## OUTPUT

```markdown
## INCIDENT POST-MORTEM COMPLETE

### Incident #[N]: [Title]
- Logged to: INCIDENT-LOG.md
- Recorded in: session state (importance: 5)
- CR rule: [CR-XX added/updated]
- VR check: [VR-XX added]
- Pattern scanner: [rule added / not automatable]
- Protocol updated: [which protocol]

### Prevention Chain
1. Session state: Will surface at session start in related domains
2. Pattern scanner: Will catch at pre-commit
3. Protocol: Explicit reminder in [protocol name]
4. CR rule: Documented in CLAUDE.md

**This failure mode is now prevented at 4 levels.**
```

## STEP 8: UPDATE SESSION STATE (MANDATORY)

Every incident MUST be recorded in session state with the wrong vs correct pattern:

```markdown
## Critical Rule: CR-[XX] - [Short Title] (Incident #[N], [date])
- [Wrong pattern description]
- [Correct pattern description]
- [Key insight that prevents recurrence]
```

This ensures that even without accessing the incident log, future sessions
will have the pattern available.

## STEP 9: CODEBASE-WIDE SEARCH (CR-9)

Search the ENTIRE codebase for the same bad pattern that caused the incident:
```bash
grep -rn "[bad_pattern]" packages/core/src/ --include="*.ts"
```
Fix ALL instances found. The incident that triggered this post-mortem
may not be the only occurrence.

## STEP 10: TOOL REGISTRATION CHECK (CR-11)

If the incident involved a tool that was implemented but not callable, run the tool registration check to verify all tools are wired into tools.ts:

```bash
# Verify all tool definitions are imported and spread
grep "getXToolDefinitions" packages/core/src/tools.ts
# Verify all handlers are wired
grep "handleXToolCall\|isXTool" packages/core/src/tools.ts
```

**Any tool module without registration in tools.ts is a hidden feature that cannot be used - fix immediately.**
