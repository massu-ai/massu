---
name: massu-hotfix
description: Quick scoped fix workflow with branch, test, commit, push, and PR creation
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-hotfix

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# CS Hotfix: Quick Scoped Fix Workflow

## Objective

Apply **minimal, targeted fixes** for production issues with fast verification and safe deployment. Fix the bug, nothing more.

**Usage**: `/massu-hotfix [description of the fix]`

---

## NON-NEGOTIABLE RULES

- **Minimal change** - Fix only the bug, no refactoring
- **Fast verification** - Streamlined checks for speed
- **Pattern compliance** - Even hotfixes follow CLAUDE.md
- **Rollback ready** - Know how to undo before applying
- **No secrets** - Security rules still apply
- **Document everything** - Full audit trail
- **FIX ALL INSTANCES (CR-9)** - If the bug exists in multiple files, fix ALL of them. Search codebase for the same pattern.

---

## ZERO-GAP AUDIT LOOP

**Even hotfixes do NOT complete until a SINGLE COMPLETE VERIFICATION finds ZERO issues.**

### The Rule

```
HOTFIX VERIFICATION LOOP:
  1. Apply minimal fix
  2. Run verification checks (patterns, types, tests)
  3. Count issues found
  4. IF issues > 0:
       - Fix ALL issues
       - Re-run ENTIRE verification from Step 2
  5. IF issues == 0:
       - HOTFIX VERIFIED
```

### Completion Requirement

| Scenario | Action |
|----------|--------|
| Fix introduces type error | Fix it, re-verify ENTIRELY |
| Re-verify finds pattern violation | Fix it, re-verify ENTIRELY |
| Re-verify finds 0 issues | **NOW** hotfix verified |

**Partial verification is NOT valid. ALL checks must pass in a SINGLE run.**

---

## HOTFIX SEVERITY LEVELS

| Level | Definition | Response Time |
|-------|------------|---------------|
| **P0** | Core functionality broken, data loss, security breach | Immediate |
| **P1** | Feature broken, no workaround | Within 1 hour |
| **P2** | Feature degraded, workaround exists | Within 4 hours |

---

## SCOPE GUARD (MANDATORY)

**This command is for SMALL fixes only. If ANY of these are true, ABORT and suggest `/massu-create-plan` instead:**

| Condition | Why It's Too Big |
|-----------|-----------------|
| Fix touches > 5 files | Needs a plan |
| Fix adds new MCP tools | Needs tool registration verification |
| Fix changes database schema | Needs migration plan |
| Fix changes config interface | Needs blast radius analysis |
| Fix requires new dependencies | Needs dependency review |
| Fix is unclear or ambiguous | Needs requirements clarification |

```
IF scope_check_fails:
  OUTPUT: "This fix is too large for /massu-hotfix. Use /massu-create-plan instead."
  ABORT
```

---

## DOMAIN-SPECIFIC PATTERN LOADING

Based on the hotfix area, load relevant patterns from CLAUDE.md:

| Domain | Section | Load When |
|--------|---------|-----------|
| Tool modules | Tool Registration Pattern | Tool handler/registration bugs |
| Config | Config Access Pattern | Config parsing/access bugs |
| Hooks | Hook stdin/stdout Pattern | Hook compilation/runtime bugs |
| Database | SQLite Database Pattern | DB access/schema bugs |
| Build | Build & Test Commands | Build/compilation issues |

---

## PHASE 1: TRIAGE (5 minutes max)

### 1.1 Document the Issue
```markdown
## HOTFIX TRIAGE

### Issue
- **Severity**: P0/P1/P2
- **Symptom**: [What's broken]
- **Impact**: [Who/what is affected]
- **Reported**: [When/by whom]

### Immediate Questions
1. Is the MCP server crashing? YES/NO
2. Is data at risk? YES/NO
3. Is it a security issue? YES/NO
4. Is there a workaround? YES/NO
```

### 1.2 Quick Investigation
```bash
# Recent commits
git log --oneline -10

# Recent changes to affected area
git log --oneline -5 -- [affected_path]
```

### 1.3 Identify Root Cause
```markdown
### Root Cause (Quick Assessment)
- **File**: [path]
- **Line**: [approximate]
- **Cause**: [brief description]
- **Confidence**: HIGH/MEDIUM/LOW
```

---

## PHASE 2: FIX DESIGN (5 minutes max)

### 2.1 Minimal Fix Plan
```markdown
### Hotfix Plan

#### Change 1
- **File**: [path]
- **Line**: [N]
- **Current**: [what exists]
- **Fix**: [what to change]
- **Why**: [brief reason]

#### Rollback
- **Command**: `git revert [hash]`
- **Alternative**: [manual steps if needed]
```

### 2.2 Pattern Check (Quick)
Before implementing, verify fix follows CLAUDE.md:
- [ ] Uses ESM imports (not require())
- [ ] Uses getConfig() (not direct YAML parse)
- [ ] Tool handlers follow 3-function pattern
- [ ] memDb closed in try/finally
- [ ] No hardcoded secrets

---

## PHASE 3: IMPLEMENT (10 minutes max)

### 3.1 Create Hotfix Branch
```bash
# Ensure clean working tree
git status --short

# From main branch
git checkout main
git pull origin main
git checkout -b hotfix/[issue-name]
```

**If working tree is dirty:**
1. Ask user if changes should be stashed
2. Do NOT proceed with dirty working tree

### 3.2 Apply Minimal Fix
- Make ONLY the change needed to fix the bug
- Do NOT refactor surrounding code
- Do NOT fix "while we're at it" issues
- Add comment if fix is non-obvious

---

## PHASE 4: FAST VERIFICATION (5 minutes)

### 4.1 Essential Checks
```bash
# Type safety
cd packages/core && npx tsc --noEmit

# Pattern scanner
bash scripts/massu-pattern-scanner.sh

# Run tests
npm test

# Hook build (if hooks modified)
cd packages/core && npm run build:hooks

# Security check
git diff --cached --name-only | grep -E '\.(env|pem|key)' && echo "FAIL" || echo "PASS"
```

### 4.2 Verification Matrix
```markdown
### Hotfix Verification

| Check | Command | Result | Status |
|-------|---------|--------|--------|
| Types | npx tsc --noEmit | 0 errors | PASS |
| Patterns | massu-pattern-scanner.sh | Exit 0 | PASS |
| Tests | npm test | All pass | PASS |
| Secrets | git diff check | 0 files | PASS |

**ALL CRITICAL CHECKS: PASS/FAIL**
```

**If ANY check fails:**
1. Fix the issue
2. Re-run ALL checks (zero-gap loop)
3. Repeat until clean

---

## PHASE 5: COMMIT & PUSH

### 5.1 Commit with Hotfix Format
```bash
git add [specific files only]

git commit -m "$(cat <<'EOF'
hotfix: [brief description]

Fixes: [issue description]
Root cause: [what was wrong]
Fix: [what was changed]

Severity: P0/P1/P2
Verified: types, patterns, tests

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

### 5.2 Create PR (If Required)

Ask user before pushing:

```bash
git push -u origin hotfix/[issue-name]

gh pr create --title "hotfix: [description]" --body "$(cat <<'EOF'
## Hotfix

### Issue
[Description of the issue]

### Root Cause
[What was wrong]

### Fix
[What was changed]

### Verification
- [ ] Types pass
- [ ] Pattern scanner passes
- [ ] All tests pass
- [ ] Tested fix locally

### Rollback Plan
`git revert [commit-hash]`
EOF
)"
```

---

## ROLLBACK PROCEDURE

If hotfix causes problems:

### Immediate Rollback
```bash
# Revert the commit
git revert [hotfix-commit-hash] --no-edit
git push origin main
```

### Verify Rollback
```bash
# Confirm no new issues from hotfix revert
npm test
cd packages/core && npx tsc --noEmit
```

---

## ABORT CONDITIONS

If at ANY point during the hotfix:

| Condition | Action |
|-----------|--------|
| Fix is more complex than expected | Abort, suggest /massu-create-plan |
| Tests fail in unrelated areas | Abort, investigate first |
| Fix would break other functionality | Abort, needs broader analysis |
| Merge conflicts with main | Abort, rebase first |

```bash
# Abort protocol
git checkout main
git branch -D hotfix/[short-description]
echo "Hotfix aborted. Reason: [reason]"
```

---

## QUICK REFERENCE

### P0 Checklist (Core Broken)
1. [ ] Identify symptom
2. [ ] Check recent commits
3. [ ] Find root cause
4. [ ] Apply minimal fix
5. [ ] Type check + tests
6. [ ] Commit and push
7. [ ] Verify fix
8. [ ] Document

### P1 Checklist (Feature Broken)
1. [ ] Document issue
2. [ ] Investigate cause
3. [ ] Design minimal fix
4. [ ] Verify patterns
5. [ ] Full verification
6. [ ] PR + review
7. [ ] Push
8. [ ] Verify + document

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state (CR-35)**

Update `session-state/CURRENT.md` to include `AUTHORIZED_COMMAND: massu-hotfix`.

Then:
1. Triage: Assess severity and impact
2. Investigate: Find root cause quickly
3. Plan: Design minimal fix with rollback
4. Implement: Make only the necessary change
5. Verify: Run essential checks
6. Commit: Commit and push
7. Document: Update session state and report

**Remember: Fix the bug, only the bug, nothing but the bug.**

---

## MANDATORY PLAN DOCUMENT UPDATE (If Hotfix From Plan)

**If hotfix was derived from a plan document, update the plan with completion status.**

```markdown
# IMPLEMENTATION STATUS

**Plan**: [Plan Name]
**Status**: HOTFIX APPLIED
**Last Updated**: [YYYY-MM-DD HH:MM]

## Hotfix Applied

| # | Fix Description | Status | Verification | Date |
|---|-----------------|--------|--------------|------|
| 1 | [Hotfix description] | COMPLETE | VR-TEST: Pass | [date] |
```

---

## SESSION STATE UPDATE

After hotfix, update `session-state/CURRENT.md`:

```markdown
## HOTFIX SESSION

### Issue
- **Severity**: P0/P1/P2
- **Symptom**: [description]

### Fix
- **File**: [path]
- **Change**: [description]
- **Commit**: [hash]

### Status
- Applied: YES
- Verified: YES

### Follow-up
[Any additional work needed]
```

---

## AUTO-LEARNING PROTOCOL (MANDATORY after every hotfix)

**Every hotfix represents a failure that MUST be recorded so the system learns.**

### After Fix is Verified:

1. **Record in session state**: Update `.claude/session-state/CURRENT.md` with the wrong pattern and correct pattern
2. **Add to pattern scanner**: If the bad pattern is grep-able, add detection to `scripts/massu-pattern-scanner.sh`
3. **Search codebase-wide**: `grep -rn "[bad_pattern]" packages/core/src/ --include="*.ts"` and fix ALL instances (CR-9)
4. **Consider new CR rule**: If this is a class of bug (not one-off), propose a new CR rule for CLAUDE.md

**Hotfixes without learning are wasted crises. Every failure teaches something -- capture it.**

---

## COMPLETION REPORT

```markdown
## CS HOTFIX COMPLETE

### Summary
- **Date**: [timestamp]
- **Severity**: P0/P1/P2
- **Time to Fix**: [duration]
- **Status**: RESOLVED

### Issue
- **Symptom**: [what was broken]
- **Impact**: [what was affected]
- **Root Cause**: [technical cause]

### Fix Applied
- **File(s)**: [paths]
- **Change**: [description]
- **Branch**: hotfix/[description]
- **Commit**: [hash]

### Verification
| Check | Status |
|-------|--------|
| Type Safety | PASS |
| Pattern Scanner | PASS |
| Tests | PASS ([N] passed) |

### Rollback Plan
git revert [commit-hash]

### PR (if created)
- **URL**: [PR URL]
- **Status**: Open

### Follow-up Required
- [ ] Add test coverage for the bug
- [ ] Review related code
- [ ] Root cause analysis

**HOTFIX COMPLETE**
```
