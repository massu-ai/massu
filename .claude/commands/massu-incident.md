---
name: massu-incident
description: "When a bug is confirmed, a production issue is found, or user reports 'this broke', 'incident', 'production error' — triggers incident documentation protocol"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), mcp__massu-codegraph__massu_memory_ingest
---
name: massu-incident

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding.

# Massu Incident: Automated Post-Mortem & Prevention Pipeline

## Objective

When a bug is discovered that an audit should have caught, execute a
structured post-mortem that AUTOMATICALLY:
1. Logs the incident to INCIDENT-LOG.md
2. Ingests it into massu memory (high importance)
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

## STEP 4: INGEST INTO MASSU MEMORY

Use `mcp__massu-codegraph__massu_memory_ingest` to record:
```json
{
  "type": "failed_attempt",
  "title": "INCIDENT #[N]: [short title]",
  "detail": "[root cause and lesson]",
  "importance": 5,
  "cr_rule": "[relevant CR]",
  "files_involved": "[file list]"
}
```

This ensures the incident surfaces automatically in future sessions
via the session-start hook's failed_attempt query.

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
- Add rule to `scripts/pattern-scanner.sh`
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
./scripts/pattern-scanner.sh

# If VR-* check added, run it:
[verification command]

# Confirm incident is in memory:
# (will surface at next session start automatically)
```

## OUTPUT

```markdown
## INCIDENT POST-MORTEM COMPLETE

### Incident #[N]: [Title]
- Logged to: INCIDENT-LOG.md
- Ingested to: massu memory (importance: 5)
- CR rule: [CR-XX added/updated]
- VR check: [VR-XX added]
- Pattern scanner: [rule added / not automatable]
- Protocol updated: [which protocol]

### Prevention Chain
1. Memory: Will surface at session start in related domains
2. Pattern scanner: Will catch at pre-push
3. Protocol: Explicit reminder in [protocol name]
4. CR rule: Documented in CLAUDE.md
5. MEMORY.md: Wrong vs correct pattern recorded for all future sessions

**This failure mode is now prevented at 5 levels.**
```

## STEP 8: UPDATE MEMORY.md (MANDATORY)

Every incident MUST be recorded in `memory/MEMORY.md` with the wrong vs correct pattern:

```markdown
## Critical Rule: CR-[XX] - [Short Title] (Incident #[N], [date])
- [Wrong pattern description]
- [Correct pattern description]
- [Key insight that prevents recurrence]
```

This ensures that even without accessing the incident log, future sessions
will have the pattern in their system prompt via MEMORY.md.

## STEP 9: CODEBASE-WIDE SEARCH (CR-9)

Search the ENTIRE codebase for the same bad pattern that caused the incident:
```bash
grep -rn "[bad_pattern]" src/ --include="*.ts" --include="*.tsx"
```
Fix ALL instances found. The incident that triggered this post-mortem
may not be the only occurrence.

## STEP 10: VR-COUPLING CHECK

If the incident involved a feature that was implemented but not exposed in the UI, run the coupling check to verify all backend procedures have UI exposure:

```bash
./scripts/check-coupling.sh
# Expected: Exit 0 (no uncoupled backend features)
```

**Any backend procedure without UI exposure is a hidden feature that cannot be used - fix immediately.**

## Gotchas

- **Ingest to memory immediately** — every incident MUST be saved to `.claude/memory/` files BEFORE the session ends. Lost incident knowledge = repeated incidents
- **Update INCIDENT-LOG.md** — every incident gets a numbered entry in `incidents/INCIDENT-LOG.md` with root cause, prevention, and CR reference
- **Add CR if pattern emerges** — if the incident reveals a repeatable failure pattern, add a new Canonical Rule to CLAUDE.md
- **Update pattern scanner** — if the incident could be caught by static analysis, add a check to `scripts/pattern-scanner.sh`
- **Never blame the user** — incidents are system failures. Frame prevention as system guardrails, not user discipline
