---
name: massu-rollback
description: Safe rollback protocol with state preservation and verification for code changes
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Massu Rollback: Safe Rollback Protocol

## Objective

Safely **rollback code changes** with state preservation, impact assessment, and verification. Know the blast radius before acting.

---

## NON-NEGOTIABLE RULES

- **Assess before acting** - Understand what will be undone
- **Preserve state** - Document current state before rollback
- **Verify rollback** - Confirm system works after rollback
- **Never force push to main** - Unless explicitly approved
- **Document everything** - Full audit trail

---

## ZERO-GAP AUDIT LOOP

**Rollback does NOT complete until a SINGLE COMPLETE VERIFICATION finds ZERO issues.**

### The Rule

```
ROLLBACK VERIFICATION LOOP:
  1. Apply rollback
  2. Run ALL verification checks (build, types, tests)
  3. Count issues found
  4. IF issues > 0:
       - Address issues
       - Re-run ENTIRE verification from Step 2
  5. IF issues == 0:
       - ROLLBACK VERIFIED
       - System stable
```

### Completion Requirement

| Scenario | Action |
|----------|--------|
| Rollback causes build failure | Fix it, re-verify ENTIRELY |
| Re-verify finds inconsistency | Fix it, re-verify ENTIRELY |
| Re-verify finds 0 issues | **NOW** rollback complete |

**Partial verification is NOT valid. ALL checks must pass in a SINGLE run after rollback.**

---

## ROLLBACK TYPES

| Type | Scope | Risk | Reversibility |
|------|-------|------|---------------|
| **Code Only** | Git revert | LOW | Easy |
| **Dependencies** | package.json | MEDIUM | Moderate |
| **Config** | massu.config.yaml | LOW | Easy |
| **Full** | Code + Config + Deps | MEDIUM | Varies |

---

## PHASE 1: ASSESSMENT

### 1.1 Identify What to Rollback
```markdown
## ROLLBACK ASSESSMENT

### Target
- **Type**: Code / Config / Dependencies / Full
- **Commits**: [hash(es)]
- **Files affected**: [count]

### Trigger
- **Issue**: [What went wrong]
- **Severity**: P0/P1/P2
- **Discovered**: [When/how]
```

### 1.2 Code Change Assessment
```bash
# View commits to rollback
git log --oneline -10

# View specific commit changes
git show [commit-hash] --stat

# View diff of commit
git show [commit-hash]

# Find all files changed in range
git diff --name-only [old-hash]..[new-hash]
```

### 1.3 Impact Matrix
```markdown
### Rollback Impact Assessment

| Area | Current State | After Rollback | Risk |
|------|--------------|----------------|------|
| Code version | [hash] | [target-hash] | LOW |
| Config state | [version] | [target-version] | LOW |
| Dependencies | [list] | [changes] | MEDIUM |

### Affected Features
- [Feature 1]: [impact]
- [Feature 2]: [impact]
```

---

## PHASE 2: STATE PRESERVATION

### 2.1 Capture Current State
```bash
# Git state
git log --oneline -5 > /tmp/rollback-git-state.txt
git status >> /tmp/rollback-git-state.txt

# Current branch and HEAD
echo "Branch: $(git branch --show-current)" >> /tmp/rollback-git-state.txt
echo "HEAD: $(git rev-parse HEAD)" >> /tmp/rollback-git-state.txt

# List of modified files
git diff --name-only HEAD~5 >> /tmp/rollback-git-state.txt
```

### 2.2 State Snapshot Document
```markdown
## PRE-ROLLBACK STATE SNAPSHOT

### Git State
- **Current HEAD**: [hash]
- **Branch**: [name]
- **Last 5 commits**: [list]

### Application State
- **Build status**: WORKING/BROKEN
- **Test status**: PASSING/FAILING
- **Last successful commit**: [hash/date]
- **Active incidents**: [list]

### Backup Locations
- Git: [remote/reflog]
- Config: [backup location]
```

---

## PHASE 3: CODE ROLLBACK

### 3.1 Revert Single Commit
```bash
# Create revert commit (SAFE - preserves history)
git revert [commit-hash] --no-edit

# Preview what will be reverted
git revert [commit-hash] --no-commit
git diff --cached

# If looks wrong, abort
git revert --abort
```

### 3.2 Revert Multiple Commits
```bash
# Revert range of commits (newest to oldest)
git revert [oldest-hash]..[newest-hash] --no-edit

# Or revert each individually
git revert [hash-1] --no-edit
git revert [hash-2] --no-edit
```

### 3.3 Reset to Specific Commit (CAUTION)
```bash
# Soft reset - keeps changes staged
git reset --soft [target-hash]

# Mixed reset - keeps changes unstaged
git reset [target-hash]

# Hard reset - DISCARDS all changes (DANGEROUS)
git reset --hard [target-hash]
# WARNING: This discards uncommitted work!
```

### 3.4 Push Rollback
```bash
# After revert commits (SAFE)
git push origin [branch]

# After hard reset (REQUIRES FORCE - DANGEROUS)
# WARNING: Only do this if explicitly approved!
git push origin [branch] --force-with-lease
```

---

## PHASE 4: DEPENDENCY ROLLBACK

### 4.1 Restore Previous package.json
```bash
# Get package.json from specific commit
git checkout [commit-hash] -- package.json package-lock.json

# Reinstall dependencies
rm -rf node_modules
npm install

# Verify lock file
npm ci
```

### 4.2 Rollback Specific Package
```bash
# Install specific version
npm install [package]@[version]

# Check what version was used before
git show [commit-hash]:package.json | grep [package]
```

---

## PHASE 5: CONFIG ROLLBACK

### 5.1 Restore Previous Config
```bash
# Get massu.config.yaml from specific commit
git checkout [commit-hash] -- massu.config.yaml

# Verify config is valid
node -e "const yaml = require('yaml'); const fs = require('fs'); console.log(yaml.parse(fs.readFileSync('massu.config.yaml', 'utf-8')));"
```

---

## PHASE 6: VERIFICATION

### 6.1 Code Verification
```bash
# Type check
cd packages/core && npx tsc --noEmit

# Build
npm run build

# Pattern scanner
bash scripts/massu-pattern-scanner.sh

# Hook compilation
cd packages/core && npm run build:hooks

# Tests
npm test
```

### 6.2 Verification Matrix
```markdown
### Post-Rollback Verification

| Check | Command | Expected | Actual | Status |
|-------|---------|----------|--------|--------|
| Type check | cd packages/core && npx tsc --noEmit | 0 errors | [N] | PASS/FAIL |
| Build | npm run build | Exit 0 | [exit code] | PASS/FAIL |
| Patterns | massu-pattern-scanner.sh | Exit 0 | [exit code] | PASS/FAIL |
| Hook Build | npm run build:hooks | Exit 0 | [exit code] | PASS/FAIL |
| Tests | npm test | All pass | [result] | PASS/FAIL |

**ALL VERIFICATIONS: PASS/FAIL**
```

---

## PHASE 7: DEPLOY ROLLBACK

### 7.1 Push to Remote
```bash
# After all verifications pass
git push origin [branch]
```

---

## ROLLBACK REPORT FORMAT

```markdown
## MASSU ROLLBACK REPORT

### Summary
- **Date**: [timestamp]
- **Type**: Code / Config / Dependencies / Full
- **Severity**: P0/P1/P2
- **Duration**: [time]

### Trigger
- **Issue**: [description]
- **Impact**: [who/what affected]
- **Decision by**: [person]

### What Was Rolled Back
- **Commits**: [list of hashes]
- **Files**: [count] files
- **Config changes**: [description or N/A]

### Rollback Method
- [ ] Git revert (safe)
- [ ] Git reset (destructive)
- [ ] Config restore
- [ ] Dependency restore

### Pre-Rollback State
- HEAD: [hash]
- Last working: [hash]

### Post-Rollback State
- HEAD: [hash]
- Status: STABLE

### Verification
| Check | Result |
|-------|--------|
| Type check | PASS |
| Build | PASS |
| Tests | PASS |
| Pattern scanner | PASS |

### Root Cause (Preliminary)
[Brief description of what caused the issue]

### Follow-up Required
- [ ] Investigate root cause
- [ ] Add tests for regression
- [ ] Update documentation
- [ ] Post-mortem meeting

**ROLLBACK STATUS: COMPLETE / PARTIAL / FAILED**
```

---

## SESSION STATE UPDATE

After rollback, update `session-state/CURRENT.md`:

```markdown
## ROLLBACK SESSION

### Trigger
- **Issue**: [description]
- **Severity**: P0/P1/P2

### Rollback
- **Type**: Code / Config / Dependencies
- **From**: [hash/version]
- **To**: [hash/version]

### Status
- Rollback applied: YES
- Verified working: YES/NO

### Follow-up
[Required actions]
```

---

## EMERGENCY QUICK REFERENCE

### Immediate Code Rollback
```bash
# Find last working commit
git log --oneline -20

# Revert to that commit (SAFE)
git revert HEAD~N..HEAD --no-edit
git push origin main
```

### If Everything Is Broken
1. Find last successful commit in git log
2. Revert to that commit
3. Push and verify
4. Fix config/deps separately if needed

---

## START NOW

1. Phase 1: Assess - What needs rollback, what's the impact
2. Phase 2: Preserve - Document and backup current state
3. Phase 3: Code Rollback - If code changes involved
4. Phase 4: Dependencies - If package changes involved
5. Phase 5: Config - If config changes involved
6. Phase 6: Verify - All checks must pass
7. Phase 7: Deploy - Push to remote
8. Document - Produce rollback report
9. Follow-up - Schedule root cause analysis

**Remember: Measure twice, rollback once.**
