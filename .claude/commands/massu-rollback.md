---
name: massu-rollback
description: "When user says 'rollback', 'revert this', 'undo changes', 'go back', or needs to safely undo code or database changes with state preservation"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), mcp__supabase__DEV__*, mcp__supabase__NEW_PROD__*, mcp__supabase__OLD_PROD__*
disable-model-invocation: true
---
name: massu-rollback

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-14, CR-5, CR-12 enforced.

# Massu Rollback: Safe Rollback Protocol

## Objective

Safely **rollback code and/or database changes** with state preservation, impact assessment, and verification. Know the blast radius before acting.

---

## NON-NEGOTIABLE RULES

- **Assess before acting** - Understand what will be undone
- **Preserve state** - Document current state before rollback
- **Database caution** - Data loss is permanent
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
  2. Run ALL verification checks (build, types, tests, DB)
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
| Re-verify finds DB inconsistency | Fix it, re-verify ENTIRELY |
| Re-verify finds 0 issues | **NOW** rollback complete |

**Partial verification is NOT valid. ALL checks must pass in a SINGLE run after rollback.**

---

## SUPABASE ENVIRONMENTS

| Environment | Project ID | MCP Tool Prefix |
|-------------|------------|-----------------|
| DEV | `gwqkbjymbarkufwvdmar` | `mcp__supabase__DEV__` |
| OLD PROD | `hwaxogapihsqleyzpqtj` | `mcp__supabase__OLD_PROD__` |
| NEW PROD | `cnfxxvrhhvjefyvpoqlq` | `mcp__supabase__NEW_PROD__` |

---

## ROLLBACK TYPES

| Type | Scope | Risk | Reversibility |
|------|-------|------|---------------|
| **Code Only** | Git revert | LOW | Easy |
| **Dependencies** | package.json | MEDIUM | Moderate |
| **Schema** | DB structure | HIGH | Hard |
| **Data** | DB content | CRITICAL | Impossible |
| **Full** | Code + DB | CRITICAL | Varies |

---

## MANDATORY PRE-ROLLBACK VERIFICATION (For Schema/Data Rollbacks)

### VR-SCHEMA-PRE: Verify Schema State BEFORE Rollback

**BEFORE executing ANY database rollback, you MUST verify current schema state.**

```sql
-- VR-SCHEMA-PRE: Query ACTUAL current state (NEVER assume)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = '[AFFECTED_TABLE]'
ORDER BY ordinal_position;

-- Verify target rollback state (from backup/history)
-- Compare current vs target to understand what will change
```

**Gate:**
- [ ] Captured current schema state
- [ ] Know target (rolled-back) schema state
- [ ] Understand all differences
- [ ] Verified in ALL affected environments

### VR-DATA: Verify Data Integrity After Rollback

**AFTER database rollback, verify data integrity matches expectations.**

```sql
-- VR-DATA: Query data to verify integrity
SELECT COUNT(*) as row_count FROM [TABLE];

-- For JSONB columns, verify key structure
SELECT DISTINCT jsonb_object_keys(config_column) as keys
FROM [TABLE]
WHERE config_column IS NOT NULL;

-- Verify no orphaned records
SELECT COUNT(*) FROM [TABLE] t
LEFT JOIN [RELATED_TABLE] r ON t.foreign_key = r.id
WHERE r.id IS NULL;
```

**Why This Is Mandatory:**
- Rollbacks can leave data in inconsistent state
- JSONB configs may have different key structures after rollback
- Foreign key relationships may be broken

**Gate:**
- [ ] Verified row counts match expectations
- [ ] Verified JSONB key structures match code expectations
- [ ] Verified no orphaned records
- [ ] Verified in ALL affected environments

---

## PHASE 1: ASSESSMENT

### 1.1 Identify What to Rollback
```markdown
## ROLLBACK ASSESSMENT

### Target
- **Type**: Code / Schema / Data / Full
- **Commits**: [hash(es)]
- **Files affected**: [count]
- **Database changes**: YES/NO

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

### 1.3 Database Change Assessment
```bash
# List recent migrations
# Use mcp__supabase__[ENV]__list_migrations

# Check what migration added/changed
# Review migration SQL
```

### 1.4 Impact Matrix
```markdown
### Rollback Impact Assessment

| Area | Current State | After Rollback | Risk |
|------|--------------|----------------|------|
| Code version | [hash] | [target-hash] | LOW |
| DB schema | [version] | [target-version] | HIGH |
| Data state | [description] | [impact] | CRITICAL |
| Dependencies | [list] | [changes] | MEDIUM |

### Affected Features
- [Feature 1]: [impact]
- [Feature 2]: [impact]

### User Impact
- Active users: [estimate]
- Data at risk: [Y/N]
- Downtime expected: [duration]
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

### 2.2 Database Backup (If DB Rollback)
```sql
-- Create backup table before destructive changes
CREATE TABLE [table]_backup_[date] AS SELECT * FROM [table];

-- Or export critical data
-- Use pg_dump or Supabase backup features
```

### 2.3 State Snapshot Document
```markdown
## PRE-ROLLBACK STATE SNAPSHOT

### Git State
- **Current HEAD**: [hash]
- **Branch**: [name]
- **Last 5 commits**: [list]

### Database State
- **Migration version**: [version]
- **Tables affected**: [list]
- **Row counts**: [table: count]

### Application State
- **Build status**: WORKING/BROKEN
- **Last successful deploy**: [hash/date]
- **Active incidents**: [list]

### Backup Locations
- Git: [remote/reflog]
- Database: [backup table/export]
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

## PHASE 5: DATABASE ROLLBACK

### 5.1 Schema Rollback (Migration Revert)
```sql
-- CAUTION: Schema rollbacks can cause data loss!

-- Drop new column (loses data in that column)
ALTER TABLE [table] DROP COLUMN [column];

-- Drop new table (loses all data in table)
DROP TABLE [table];

-- Revert column type change
ALTER TABLE [table] ALTER COLUMN [column] TYPE [old_type];
```

### 5.2 Apply Rollback Migration
Apply to environments in order: DEV first, then OLD PROD, then NEW PROD

```sql
-- Always wrap in transaction
BEGIN;

-- Your rollback SQL here
-- ...

-- Verify before commit
SELECT * FROM [table] LIMIT 5;

COMMIT;
-- Or ROLLBACK; if something is wrong
```

### 5.3 Data Rollback (If Backup Exists)
```sql
-- CRITICAL: Data loss is permanent without backup!

-- Restore from backup table
INSERT INTO [table] SELECT * FROM [table]_backup_[date]
ON CONFLICT (id) DO UPDATE SET
  column1 = EXCLUDED.column1,
  column2 = EXCLUDED.column2;

-- Or full restore (DESTRUCTIVE)
TRUNCATE TABLE [table];
INSERT INTO [table] SELECT * FROM [table]_backup_[date];
```

### 5.4 RLS Policy Rollback
```sql
-- Drop new policies
DROP POLICY IF EXISTS "[policy_name]" ON [table];

-- Restore old policies
CREATE POLICY "[old_policy_name]" ON [table]
    FOR [SELECT/INSERT/UPDATE/DELETE]
    TO [role]
    USING ([condition]);
```

---

## PHASE 6: VERIFICATION

### 6.1 Code Verification
```bash
# Type check
npx tsc --noEmit

# Build
npm run build

# Pattern scanner
./scripts/pattern-scanner.sh

# VR-COUPLING: Backend-frontend sync (CRITICAL - Added Jan 2026)
./scripts/check-coupling.sh
# Expected: Exit 0 - all backend features exposed in UI

# Tests
npm test
```

### 6.2 Database Verification
```sql
-- Verify schema state
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = '[table]';

-- Verify RLS
SELECT polname FROM pg_policies WHERE tablename = '[table]';

-- Verify row counts
SELECT COUNT(*) FROM [table];

-- Verify data integrity
SELECT * FROM [table] WHERE [expected_condition] LIMIT 5;
```

### 6.3 Application Verification
```bash
# Start dev server
npm run dev

# Check critical routes respond
curl -I http://localhost:3000/
curl -I http://localhost:3000/api/health
```

### 6.4 Verification Matrix
```markdown
### Post-Rollback Verification

| Check | Command | Expected | Actual | Status |
|-------|---------|----------|--------|--------|
| Type check | npx tsc --noEmit | 0 errors | [N] | PASS/FAIL |
| Build | npm run build | Exit 0 | [exit code] | PASS/FAIL |
| Patterns | pattern-scanner.sh | Exit 0 | [exit code] | PASS/FAIL |
| VR-COUPLING | check-coupling.sh | Exit 0 | [exit code] | PASS/FAIL |
| Tests | npm test | All pass | [result] | PASS/FAIL |
| DB Schema | SQL query | [expected] | [actual] | PASS/FAIL |
| App starts | npm run dev | No errors | [result] | PASS/FAIL |

**ALL VERIFICATIONS: PASS/FAIL**
```

---

## PHASE 7: DEPLOY ROLLBACK

### 7.1 Push to Production
```bash
# After all verifications pass
git push origin main

# Monitor deployment
# Watch Vercel/deployment platform
```

### 7.2 Post-Deploy Verification
```bash
# Check production site
curl -I https://[production-url]/

# Check API health
curl https://[production-url]/api/health

# Monitor logs for errors
# Use mcp__supabase__NEW_PROD__get_logs for each service
```

---

## ROLLBACK REPORT FORMAT

```markdown
## MASSU ROLLBACK REPORT

### Summary
- **Date**: [timestamp]
- **Type**: Code / Schema / Data / Full
- **Severity**: P0/P1/P2
- **Duration**: [time]

### Trigger
- **Issue**: [description]
- **Impact**: [who/what affected]
- **Decision by**: [person]

### What Was Rolled Back
- **Commits**: [list of hashes]
- **Files**: [count] files
- **DB changes**: [description or N/A]

### Rollback Method
- [ ] Git revert (safe)
- [ ] Git reset (destructive)
- [ ] Migration revert
- [ ] Data restore

### Pre-Rollback State
- HEAD: [hash]
- DB version: [version]
- Last working: [hash]

### Post-Rollback State
- HEAD: [hash]
- DB version: [version]
- Status: STABLE

### Verification
| Check | Result |
|-------|--------|
| Type check | PASS |
| Build | PASS |
| Tests | PASS |
| DB integrity | PASS |
| Production | WORKING |

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
- **Type**: Code / Schema / Data
- **From**: [hash/version]
- **To**: [hash/version]

### Status
- Rollback applied: YES
- Verified working: YES/NO
- Production stable: YES/NO

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

### Immediate DB Rollback (DANGER)
```sql
-- Only if backup exists!
-- Restore from backup table
INSERT INTO [table] SELECT * FROM [table]_backup_[date]
ON CONFLICT (id) DO UPDATE SET ...;
```

### If Everything Is Broken
1. Check Vercel for last successful deployment
2. Find corresponding git commit
3. Revert to that commit
4. Push and monitor deployment
5. Fix database separately if needed

---

## START NOW

1. Phase 1: Assess - What needs rollback, what's the impact
2. Phase 2: Preserve - Document and backup current state
3. Phase 3: Code Rollback - If code changes involved
4. Phase 4: Dependencies - If package changes involved
5. Phase 5: Database - If schema/data changes involved (CAREFUL)
6. Phase 6: Verify - All checks must pass
7. Phase 7: Deploy - Push to production
8. Document - Produce rollback report
9. Follow-up - Schedule root cause analysis

**Remember: Measure twice, rollback once. Data loss is forever.**
