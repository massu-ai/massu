---
name: massu-golden-path
description: Complete end-to-end workflow from plan to push with minimal pause points
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), Task(*)
---
name: massu-golden-path

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Massu Golden Path: Conception to Production Push

## Objective

Execute the COMPLETE development workflow in one continuous run:
**Plan Validation --> Implementation --> Verification --> Commit --> Push**

---

## NON-NEGOTIABLE RULES

- **Complete workflow** - ALL 5 phases must execute, no skipping
- **Zero failures** - Each phase gate must pass before proceeding
- **Proof required** - Show output of each phase gate
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - If ANY issue is discovered during golden path execution - whether from current changes OR pre-existing - fix it immediately. "Not in scope" and "pre-existing" are NEVER valid reasons to skip a fix. When fixing a bug, search entire codebase for same pattern and fix ALL instances.

---

## THE UBER-COMMAND PROTOCOL

```
+-----------------------------------------------------------------------------+
|                                                                             |
|   THIS COMMAND RUNS STRAIGHT THROUGH THE ENTIRE GOLDEN PATH.               |
|   IT ONLY PAUSES FOR 3 CRITICAL APPROVAL POINTS:                           |
|                                                                             |
|   1. NEW PATTERN APPROVAL - If a new pattern is needed                     |
|   2. COMMIT APPROVAL - Before creating the commit                          |
|   3. PUSH APPROVAL - Before pushing to remote                              |
|                                                                             |
|   EVERYTHING ELSE RUNS AUTOMATICALLY WITHOUT STOPPING.                     |
|                                                                             |
+-----------------------------------------------------------------------------+
```

---

## APPROVAL POINT PROTOCOL

### When Pausing for Approval

Use this EXACT format for each approval point:

```
===============================================================================
APPROVAL REQUIRED: [TYPE]
===============================================================================

[Details of what needs approval]

OPTIONS:
  - Type "approve" or "yes" to continue
  - Type "modify" to request changes
  - Type "abort" to stop the golden path

===============================================================================
```

### After Receiving Approval

Immediately continue to the next phase. Do NOT ask "shall I continue?" - just proceed.

---

## PHASE 1: PLAN VALIDATION

### 1.1 Load and Read Plan

```
[GOLDEN PATH - PHASE 1: PLAN VALIDATION]
Loading plan file...
```

- Read the plan file provided by user
- If no plan file provided, ask user for the plan/task description

### 1.2 Load Project Configuration

Read these files to extract project requirements:
- `.claude/CLAUDE.md`
- `massu.config.yaml`

### 1.3 Build Pattern Alignment Matrix

Create matrix showing:
- All applicable patterns
- Whether plan addresses each pattern
- Gaps identified

### 1.4 If Gaps Found in Plan

**DO NOT PAUSE** - Fix the gaps automatically:
1. Add missing pattern references to plan
2. Add missing sections
3. Report what was added
4. Continue to next step

### 1.5 If NEW PATTERN Needed

**PAUSE FOR APPROVAL POINT #1**

```
===============================================================================
APPROVAL REQUIRED: NEW PATTERN
===============================================================================

A new pattern is needed for: [functionality]

Existing patterns checked:
- [pattern 1]: Not suitable because [reason]
- [pattern 2]: Not suitable because [reason]

PROPOSED NEW PATTERN:
Name: [Pattern Name]
Domain: [Config/MCP/Hook/etc.]
Purpose: [What it solves]

WRONG (Never do this):
[code]

CORRECT (Always do this):
[code]

Error if violated: [What breaks]

OPTIONS:
  - Type "approve" to save this pattern and continue
  - Type "modify: [changes]" to adjust the pattern
  - Type "abort" to stop

===============================================================================
```

After approval:
1. Save pattern to appropriate files
2. Update pattern alignment matrix
3. Continue immediately to Phase 2

### 1.6 Plan Validation Complete

```
[GOLDEN PATH - PHASE 1 COMPLETE]
- Plan validated against all patterns
- Pattern alignment matrix: PASS
- Proceeding to Phase 2: Implementation...
```

---

## PHASE 2: IMPLEMENTATION

### 2.1 Initialize

```
[GOLDEN PATH - PHASE 2: IMPLEMENTATION]
Starting implementation with zero-gap verification...
```

- Initialize session state
- Create checklist for all plan items

### 2.2 Execute Implementation Loop

For each plan item:
1. **Execute** - Implement the item
2. **Verify** - Run VR-* checks
3. **Audit** - Check for pattern violations
4. **Fix** - If gaps found, fix and re-verify
5. **Continue** - Move to next item

**DO NOT STOP** between items. Only stop if:
- New pattern needed (Approval Point #1)
- True blocker (external service, credentials)
- Critical error after 3 retries

### 2.3 Pattern Discovery During Implementation

If during implementation a new pattern is needed:
1. **PAUSE** for Approval Point #1 (same format as above)
2. After approval, save pattern
3. **CONTINUE** implementation immediately

### 2.4 Zero-Gap Audit Loop

After all items implemented:
```
ZERO-GAP AUDIT LOOP:
  Loop 1: Run all checks -> Found N gaps -> Fix all -> Restart
  Loop 2: Run all checks -> Found M gaps -> Fix all -> Restart
  Loop N: Run all checks -> Found 0 gaps -> PASS
```

### 2.5 Implementation Complete

```
[GOLDEN PATH - PHASE 2 COMPLETE]
- All plan items implemented
- Zero-gap audit: PASSED (Loop #N)
- Pattern scanner: Exit 0
- Type check: 0 errors
- Build: Exit 0
- Proceeding to Phase 3: Pre-Commit Verification...
```

---

## PHASE 3: PRE-COMMIT VERIFICATION

### 3.1 Run Full Verification Suite

```
[GOLDEN PATH - PHASE 3: PRE-COMMIT VERIFICATION]
Running verification suite...
```

Execute ALL checks:
```bash
# Pattern scanner
bash scripts/massu-pattern-scanner.sh

# Type check
cd packages/core && npx tsc --noEmit

# Build
npm run build

# Tests
npm test

# Security check
bash scripts/massu-security-scanner.sh

# Secret check
git diff --cached --name-only | grep -E '\.(env|pem|key|secret)'
```

### 3.2 If Verification Fails

**DO NOT PAUSE** - Fix automatically:
1. Fix each issue
2. Re-run verification
3. Repeat until all pass

### 3.3 Pre-Commit Complete - PAUSE FOR APPROVAL

**APPROVAL POINT #2: COMMIT**

```
===============================================================================
APPROVAL REQUIRED: COMMIT
===============================================================================

All verification checks passed. Ready to commit.

VERIFICATION RESULTS:
- Pattern scanner: Exit 0
- Type check: 0 errors
- Build: Exit 0
- Tests: ALL pass
- Security: No secrets staged

FILES TO BE COMMITTED:
[list of files]

PROPOSED COMMIT MESSAGE:
[commit type]: [description]

[body if needed]

Co-Authored-By: Claude <noreply@anthropic.com>

OPTIONS:
  - Type "approve" to create this commit and continue to push
  - Type "message: [new message]" to change commit message
  - Type "abort" to stop (changes remain staged)

===============================================================================
```

After approval:
1. Create the commit with the message
2. Report commit hash
3. Continue immediately to Phase 4

---

## PHASE 4: PUSH VERIFICATION & PUSH

### 4.1 Pre-Push Verification

```
[GOLDEN PATH - PHASE 4: PUSH VERIFICATION]
Running pre-push verification...
```

- Verify commit was successful
- Check remote branch status
- Ensure no conflicts with remote

### 4.2 Final Verification

```bash
# Verify local matches expectations
git log -1 --oneline
git diff HEAD~1 --stat
```

### 4.3 Push Approval - FINAL PAUSE

**APPROVAL POINT #3: PUSH**

```
===============================================================================
APPROVAL REQUIRED: PUSH TO REMOTE
===============================================================================

Ready to push to remote.

COMMIT DETAILS:
Hash: [commit hash]
Message: [commit message]
Files changed: [N]
Insertions: +[N]
Deletions: -[N]

PUSH TARGET:
  Branch: [branch name]
  Remote: origin

OPTIONS:
  - Type "approve" or "push" to push to remote
  - Type "abort" to stop (commit remains local)

===============================================================================
```

After approval:
1. Execute `git push`
2. Report push success
3. Continue to completion

---

## PHASE 5: COMPLETION

### 5.1 Final Report

```
===============================================================================
GOLDEN PATH COMPLETE
===============================================================================

SUMMARY:
Phase 1: Plan Validation      COMPLETE
Phase 2: Implementation       COMPLETE (N audit loops)
Phase 3: Pre-Commit           COMPLETE
Phase 4: Push                 COMPLETE

DELIVERABLES:
  - Commit: [hash]
  - Branch: [branch]
  - Pushed: YES
  - Files changed: [N]

NEW PATTERNS CREATED (if any):
  - [Pattern name] -> saved to [file]

VERIFICATION EVIDENCE:
  - Pattern scanner: Exit 0
  - Type check: 0 errors
  - Build: Exit 0
  - Tests: ALL pass

===============================================================================
```

### 5.2 Update Session State

Update `session-state/CURRENT.md` with completion status.

### 5.3 MANDATORY: Update Plan Document

**The plan document MUST be updated with completion status.**

Add completion table to TOP of plan document:

```markdown
# IMPLEMENTATION STATUS

**Plan**: [Plan Name]
**Status**: COMPLETE
**Last Updated**: [YYYY-MM-DD HH:MM]
**Completed By**: Claude Code (Massu Golden Path)

## Task Completion Summary

| # | Task/Phase | Status | Verification | Date |
|---|------------|--------|--------------|------|
| 1 | [Task description] | 100% COMPLETE | VR-BUILD: Pass | [date] |
| 2 | [Task description] | 100% COMPLETE | VR-GREP: 0 refs | [date] |

## Verification Evidence

### Phase 1: [Name]
- Pattern scanner: Exit 0
- Type check: 0 errors
- Build: Exit 0

### Commit
- Hash: [commit hash]
- Message: [message]
- Pushed: YES
```

**VR-PLAN-STATUS Verification:**
```bash
# Verify plan has completion status
grep "IMPLEMENTATION STATUS" [plan_file]
grep "COMPLETE" [plan_file]
# Expected: Matches found
```

---

## QUICK REFERENCE: APPROVAL POINTS

| # | Type | When | User Response |
|---|------|------|---------------|
| 1 | NEW PATTERN | When functionality needs pattern not in CLAUDE.md | "approve" / "modify" / "abort" |
| 2 | COMMIT | After all verification passes, before commit | "approve" / "message: X" / "abort" |
| 3 | PUSH | After commit, before push | "approve" / "push" / "abort" |

**Everything else runs automatically without stopping.**

---

## ABORT HANDLING

If user types "abort" at any approval point:

```
===============================================================================
GOLDEN PATH ABORTED
===============================================================================

Stopped at: [Phase N - Approval Point]

CURRENT STATE:
  - Completed phases: [list]
  - Pending phases: [list]
  - Files changed: [list]
  - Commit created: YES/NO
  - Pushed: NO

TO RESUME:
  Run /massu-golden-path again with the same plan
  Or run individual commands:
    /massu-loop      - Continue implementation
    /massu-commit    - Run commit verification
    /massu-push      - Run push verification

===============================================================================
```

---

## ERROR HANDLING

### Recoverable Errors

If an error occurs that can be fixed:
1. Attempt to fix automatically
2. Re-run the failed step
3. If fixed, continue without pausing
4. If not fixable after 3 attempts, pause and report

### Non-Recoverable Errors

If a true blocker occurs:
```
===============================================================================
GOLDEN PATH BLOCKED
===============================================================================

BLOCKER: [Description]

This requires manual intervention:
[Specific instructions to resolve]

After resolving, run /massu-golden-path again to resume.

===============================================================================
```

---

## INVOCATION

### With Plan File
```
/massu-golden-path /path/to/plan.md
```

### With Task Description
```
/massu-golden-path
"Implement feature X that does Y"
```

### With Existing Work
```
/massu-golden-path
"Continue from where we left off on [feature]"
```

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state**

Before any other work, update `session-state/CURRENT.md` to include:
```
AUTHORIZED_COMMAND: massu-golden-path
```

1. **Determine input**: Plan file or task description
2. **Begin Phase 1**: Load and validate plan
3. **Continue through all phases** automatically
4. **Pause only at approval points** (max 3 pauses)
5. **Complete with push** and final report

**This command does NOT stop to ask "should I continue?" - it runs straight through.**
