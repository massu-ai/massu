---
name: massu-hotfix
description: "When user needs an urgent fix -- 'hotfix', 'emergency fix', 'broken and needs immediate patch'"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-hotfix

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-5, CR-12 enforced.

> **Config lookup (framework-aware)**: This command reads `config.framework.type` and `config.verification.<primary_language>` from `massu.config.yaml` to choose the right verification commands. Hardcoded references below to `packages/core`, `tools.ts`, `vitest`, `VR-TOOL-REG`, and `VR-HOOK-BUILD` are **MCP-project specific** and only apply when `config.framework.type === 'mcp'` (or `languages.typescript.runtime === 'mcp'`). For other projects, substitute: type-check → `config.verification.<primary_language>.type`, tests → `.test`, build → `.build`, lint → `.lint`. See `.claude/reference/vr-verification-reference.md` for the config-driven VR-* catalog.

# Massu Hotfix: Emergency Fix Protocol

## Objective

Apply **minimal, targeted fixes** for production issues with fast verification and safe deployment. Fix the bug, nothing more.

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

**Even hotfixes do NOT deploy until a SINGLE COMPLETE VERIFICATION finds ZERO issues.**

### The Rule

```
HOTFIX VERIFICATION LOOP:
  1. Apply minimal fix
  2. Run verification checks (patterns, types, build, tests)
  3. Count issues found
  4. IF issues > 0:
       - Fix ALL issues
       - Re-run ENTIRE verification from Step 2
  5. IF issues == 0:
       - HOTFIX VERIFIED
       - Safe to deploy
```

### Completion Requirement

| Scenario | Action |
|----------|--------|
| Fix introduces type error | Fix it, re-verify ENTIRELY |
| Re-verify finds pattern violation | Fix it, re-verify ENTIRELY |
| Re-verify finds 0 issues | **NOW** hotfix can deploy |

**Partial verification is NOT valid. ALL checks must pass in a SINGLE run before deploy.**

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

Based on the hotfix area, load relevant pattern files:

| Domain | Pattern File | Load When |
|--------|--------------|-----------|
| Tool modules | `.claude/patterns/tool-patterns.md` | Tool handler/registration bugs |
| Config | `.claude/patterns/config-patterns.md` | Config parsing/access bugs |
| Hooks | `.claude/patterns/hook-patterns.md` | Hook compilation/runtime bugs |
| Build issues | `.claude/patterns/build-patterns.md` | Build/deploy issues |

---

## MANDATORY VERIFICATION (For Database Hotfixes)

### VR-SCHEMA-PRE: Verify Schema BEFORE Applying Database Hotfix

**WHEN hotfixing database-related issues, ALWAYS verify schema first.**

```sql
-- VR-SCHEMA-PRE: Query ACTUAL columns (even in emergency)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = '[AFFECTED_TABLE]'
ORDER BY ordinal_position;
```

**Why This Is Mandatory (Even for Emergencies):**
- Wrong column name in hotfix = 500 error = makes things WORSE
- Take 30 seconds to verify schema, save hours of debugging
- Schema mismatch is a common root cause of bugs

### VR-CONFIG: Verify Config for "Not Working" Hotfixes

**If hotfixing "tool not found" or config issues, verify config-code alignment FIRST.**

```bash
# VR-CONFIG: Verify config values match code expectations
cat massu.config.yaml
grep -rn "getConfig()" packages/core/src/ | head -10
```

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
- [ ] No hardcoded secrets
- [ ] Error handling present

---

## PHASE 3: IMPLEMENT (10 minutes max)

### 3.1 Create Hotfix Branch
```bash
# Ensure clean working tree
git status --short

# From main/production branch
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

### 3.3 Verify Fix Locally
```bash
# Quick verification
npx tsc --noEmit
npm run build

# Pattern check
bash scripts/massu-pattern-scanner.sh
```

---

## PHASE 4: FAST VERIFICATION (5 minutes)

### 4.1 Essential Checks Only
```bash
# Type safety
npx tsc --noEmit

# Build integrity
npm run build

# Pattern scanner
bash scripts/massu-pattern-scanner.sh

# Tests
npm test

# Security check
git diff --cached --name-only | grep -E '\.(env|pem|key)' && echo "FAIL" || echo "PASS"
```

### 4.2 Verification Matrix
```markdown
### Hotfix Verification

| Check | Command | Result | Status |
|-------|---------|--------|--------|
| Types | npx tsc --noEmit | 0 errors | PASS |
| Build | npm run build | Exit 0 | PASS |
| Patterns | massu-pattern-scanner.sh | Exit 0 | PASS |
| Tests | npm test | All pass | PASS |
| Secrets | git diff check | 0 files | PASS |

**ALL CRITICAL CHECKS: PASS/FAIL**
```

---

## PHASE 5: COMMIT & DEPLOY

### 5.1 Commit with Hotfix Format
```bash
git add [specific files only]
git commit -m "$(cat <<'EOF'
hotfix: [brief description]

Fixes: [issue description]
Root cause: [what was wrong]
Fix: [what was changed]

Severity: P0/P1/P2
Verified: types, build, patterns, tests

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

### 5.2 Create PR (If Required)
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
- [ ] Build passes
- [ ] Pattern scanner passes
- [ ] All tests pass
- [ ] Tested fix locally

### Rollback Plan
`git revert [commit-hash]`
EOF
)"
```

### 5.3 Deploy
```bash
# After PR approval (or direct push if P0)
git checkout main
git merge hotfix/[issue-name]
git push origin main

# Monitor deployment
```

---

## PHASE 6: POST-DEPLOY VERIFICATION

### 6.1 Verify Fix
```markdown
### Post-Deploy Verification

| Check | Result | Status |
|-------|--------|--------|
| Issue reproduced? | NO | PASS |
| Feature working? | YES | PASS |
| No new errors? | YES | PASS |
| Logs clean? | YES | PASS |
```

### 6.2 Monitor for Regressions
```bash
# Check for new errors in output/logs
# Run tests again post-deploy
npm test
```

---

## HOTFIX REPORT FORMAT

```markdown
## MASSU HOTFIX REPORT

### Summary
- **Date**: [timestamp]
- **Severity**: P0/P1/P2
- **Time to Fix**: [duration]
- **Status**: RESOLVED

### Issue
- **Symptom**: [what was broken]
- **Impact**: [who was affected]
- **Root Cause**: [technical cause]

### Fix Applied
- **File(s)**: [paths]
- **Change**: [description]
- **Commit**: [hash]

### Verification
| Check | Result |
|-------|--------|
| Types | PASS |
| Build | PASS |
| Patterns | PASS |
| Tests | PASS |

### Rollback Plan
```bash
git revert [commit-hash]
```

### Follow-up Required
- [ ] Add test coverage
- [ ] Review related code
- [ ] Root cause analysis

**HOTFIX COMPLETE**
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

## MANDATORY PLAN DOCUMENT UPDATE (If Hotfix From Plan)

**If hotfix was derived from a plan document, update the plan with completion status.**

### Plan Document Update (Add to TOP of plan if applicable)

```markdown
# IMPLEMENTATION STATUS

**Plan**: [Plan Name]
**Status**: HOTFIX APPLIED
**Last Updated**: [YYYY-MM-DD HH:MM]

## Hotfix Applied

| # | Fix Description | Status | Verification | Date |
|---|-----------------|--------|--------------|------|
| 1 | [Hotfix description] | COMPLETE | VR-TEST: Pass | [date] |

## Verification Evidence

### Hotfix: [Name]
- Command: `npm run build && npm test`
- Result: Exit 0
- Status: VERIFIED COMPLETE
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
npx tsc --noEmit
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
5. [ ] Type check + build + tests
6. [ ] Deploy immediately
7. [ ] Verify
8. [ ] Document

### P1 Checklist (Feature Broken)
1. [ ] Document issue
2. [ ] Investigate cause
3. [ ] Design minimal fix
4. [ ] Verify patterns
5. [ ] Full verification
6. [ ] PR + review
7. [ ] Deploy
8. [ ] Verify + document

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state (CR-12)**

Before any other work, update `session-state/CURRENT.md` to include:
```
AUTHORIZED_COMMAND: massu-hotfix
```
This ensures that if the session compacts, the recovery protocol knows only `/massu-hotfix` was authorized.

1. Triage: Assess severity and impact
2. Investigate: Find root cause quickly
3. Plan: Design minimal fix with rollback
4. Implement: Make only the necessary change
5. Verify: Run essential checks
6. Deploy: Commit and push
7. Confirm: Verify fix
8. Document: Update session state and report

**Remember: Fix the bug, only the bug, nothing but the bug.**

---

## AUTO-LEARNING PROTOCOL (MANDATORY after every hotfix)

**Every hotfix represents a failure that MUST be recorded so the system learns.**

### After Fix is Deployed and Verified:

1. **Ingest into massu memory**: Use `mcp__massu-codegraph__massu_memory_ingest` with type="bugfix", importance=5 (hotfixes are always high importance), description of root cause + fix
2. **Record in session state**: Add the wrong pattern and correct pattern to `.claude/session-state/CURRENT.md`
3. **Add to pattern scanner**: If the bad pattern is grep-able, add detection to `scripts/massu-pattern-scanner.sh`
4. **Search codebase-wide**: `grep -rn "[bad_pattern]" packages/core/src/` and fix ALL instances (CR-9)
5. **Consider new CR rule**: If this is a class of bug (not one-off), propose a new CR rule for CLAUDE.md

**Hotfixes without learning are wasted crises. Every outage teaches something -- capture it.**
