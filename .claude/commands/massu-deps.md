---
name: massu-deps
description: Dependency audit covering security vulnerabilities, updates, and compatibility analysis
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---
name: massu-deps

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Massu Deps: Dependency Audit Protocol

## Objective

Audit project dependencies for **security vulnerabilities**, outdated packages, and compatibility issues. Maintain a healthy, secure dependency tree.

---

## NON-NEGOTIABLE RULES

- **Security first** - Critical/high vulnerabilities block deployment
- **Compatibility check** - Verify updates don't break build
- **Incremental updates** - Don't update everything at once
- **Test after updates** - Build and type check required
- **Document changes** - Track what was updated and why

---

## ZERO-GAP AUDIT LOOP

**Dependency updates do NOT complete until a SINGLE COMPLETE AUDIT finds ZERO issues.**

### The Rule

```
DEPENDENCY AUDIT LOOP:
  1. Run ALL security and compatibility checks
  2. Count vulnerabilities and issues found
  3. IF issues > 0:
       - Fix/update to address issues
       - Re-run ENTIRE audit from Step 1
  4. IF issues == 0:
       - DEPENDENCIES VERIFIED
```

### Completion Requirement

| Scenario | Action |
|----------|--------|
| Audit finds 3 vulnerabilities | Fix all 3, re-run ENTIRE audit |
| Update breaks build | Fix compatibility, re-run ENTIRE audit |
| Re-audit finds 0 issues | **NOW** dependencies verified |

**Partial re-checks are NOT valid. The ENTIRE dependency audit must pass in a SINGLE run.**

---

## AUDIT SECTION 1: SECURITY VULNERABILITIES

### 1.1 npm Audit (Root)
```bash
# Run full audit from root
npm audit

# Check for critical/high only
npm audit --audit-level=high

# Check packages/core specifically
cd packages/core && npm audit
```

### 1.2 npm Audit (Website, if applicable)
```bash
# Website dependencies
cd website && npm audit 2>/dev/null || echo "No website package"
```

### 1.3 Vulnerability Matrix
```markdown
### Security Vulnerabilities

| Package | Location | Severity | Vulnerability | Fix Available | Action |
|---------|----------|----------|---------------|---------------|--------|
| [pkg] | core | CRITICAL | [CVE-XXXX] | YES/NO | UPDATE/REPLACE |
| [pkg] | website | HIGH | [CVE-XXXX] | YES/NO | UPDATE/REPLACE |
```

### 1.4 Auto-fix (If Safe)
```bash
# Attempt automatic fix
npm audit fix

# Force fix (may have breaking changes - REVIEW FIRST)
npm audit fix --force --dry-run  # Preview
```

---

## AUDIT SECTION 2: OUTDATED PACKAGES

### 2.1 Check Outdated
```bash
# Root outdated
npm outdated

# Core package outdated
cd packages/core && npm outdated

# Website outdated (if applicable)
cd website && npm outdated 2>/dev/null
```

### 2.2 Outdated Matrix
```markdown
### Outdated Packages

| Package | Current | Wanted | Latest | Location | Action |
|---------|---------|--------|--------|----------|--------|
| [pkg] | 1.0.0 | 1.0.5 | 2.0.0 | core | PATCH |
| [pkg] | 2.1.0 | 2.1.0 | 3.0.0 | website | REVIEW |
```

### 2.3 Update Priority
| Priority | Definition | Criteria |
|----------|------------|----------|
| **P0** | Security fix | Has vulnerability fix |
| **P1** | Bug fix | Patch version, bug fixes |
| **P2** | Minor update | New features, backward compatible |
| **P3** | Major update | Breaking changes, needs migration |

---

## AUDIT SECTION 3: DEPENDENCY ANALYSIS

### 3.1 Dependency Tree
```bash
# Full tree
npm ls --depth=2

# Find specific package
npm ls [package-name]

# Why is package installed?
npm why [package-name]
```

### 3.2 Duplicate Detection
```bash
# Find duplicates
npm dedupe --dry-run
```

### 3.3 Unused Dependencies
```bash
# Find potentially unused (packages/core)
npx depcheck packages/core

# Verify no phantom MCP SDK references (should be 0 — raw JSON-RPC 2.0)
grep -rn "@modelcontextprotocol/sdk" packages/core/src/ --include="*.ts" | wc -l

# Check better-sqlite3 usage
grep -rn "better-sqlite3\|Database" packages/core/src/ --include="*.ts" | wc -l
```

### 3.4 Dependency Matrix
```markdown
### Dependency Analysis

| Package | Direct | Versions | Used | Action |
|---------|--------|----------|------|--------|
| [pkg] | YES | 1 | YES | KEEP |
| [pkg] | NO | 2 | - | DEDUPE |
| [pkg] | YES | 1 | NO | REMOVE |
```

---

## AUDIT SECTION 4: COMPATIBILITY CHECK

### 4.1 Peer Dependencies
```bash
# Check peer dependency warnings
npm ls 2>&1 | grep -i "peer dep\|WARN"
```

### 4.2 Engine Compatibility
```bash
# Check Node.js version requirement
grep -A 5 '"engines"' packages/core/package.json

# Current Node.js version
node --version
```

### 4.3 TypeScript Compatibility
```bash
# Verify TypeScript version
npx tsc --version

# Check for type definition updates
npm outdated | grep @types
```

---

## AUDIT SECTION 5: UPDATE PROCESS

### 5.1 Safe Update Order
1. **Dev dependencies first** (lower risk)
2. **Patch updates** (bug fixes only)
3. **Minor updates** (backward compatible)
4. **Major updates** (one at a time, test thoroughly)

### 5.2 Post-Update Verification
```bash
# After EACH update:

# 1. Type check
cd packages/core && npx tsc --noEmit

# 2. Build (includes hook compilation)
npm run build

# 3. Test
npm test

# 4. Pattern scanner
bash scripts/massu-pattern-scanner.sh

# 5. Security scanner
bash scripts/massu-security-scanner.sh
```

### 5.3 Update Checklist
```markdown
### Package Update: [PACKAGE_NAME]

- [ ] Reviewed changelog for breaking changes
- [ ] Updated package: `npm install [pkg]@[version]`
- [ ] Type check passes
- [ ] Build passes
- [ ] Tests pass
- [ ] Pattern scanner passes
```

---

## AUDIT SECTION 6: LOCK FILE INTEGRITY

### 6.1 Lock File Check
```bash
# Verify lock file integrity
npm ci

# If issues, regenerate
rm -rf node_modules package-lock.json
npm install
```

---

## DEPENDENCY REPORT FORMAT

```markdown
## MASSU DEPS AUDIT REPORT

### Summary
- **Date**: [timestamp]
- **Total packages**: [N]
- **Direct dependencies**: [N]
- **Dev dependencies**: [N]

### Security Status
| Severity | Count | Action Required |
|----------|-------|-----------------|
| Critical | 0 | IMMEDIATE |
| High | 0 | ASAP |
| Moderate | 0 | PLANNED |
| Low | 0 | DEFER |

**Security Status: PASS / BLOCKED**

### Outdated Packages
| Priority | Count | Packages |
|----------|-------|----------|
| P0 Security | 0 | [list] |
| P1 Patches | N | [list] |
| P2 Minor | N | [list] |
| P3 Major | N | [list] |

### Updates Applied
| Package | From | To | Breaking | Status |
|---------|------|----|---------| -------|
| [pkg] | X.X.X | Y.Y.Y | NO | PASS |

### Verification
| Check | Result |
|-------|--------|
| npm audit | PASS |
| Type check | PASS |
| Build | PASS |
| Tests | PASS |
| Pattern scanner | PASS |

### Recommendations
1. [Recommendation 1]
2. [Recommendation 2]

**DEPENDENCY HEALTH: GOOD / NEEDS ATTENTION / CRITICAL**
```

---

## SESSION STATE UPDATE

After audit, update `session-state/CURRENT.md`:

```markdown
## DEPS AUDIT SESSION

### Audit
- **Date**: [timestamp]
- **Type**: Security / Full

### Findings
- Critical vulnerabilities: [N]
- Outdated packages: [N]
- Unused packages: [N]

### Updates Applied
- [package]: X.X.X -> Y.Y.Y

### Status
- All checks passing: YES/NO
```

---

## QUICK COMMANDS

```bash
# Quick security check
npm audit --audit-level=high

# Quick outdated check
npm outdated

# Update all patches (safe)
npm update

# Fix vulnerabilities (safe)
npm audit fix

# Full clean install
rm -rf node_modules package-lock.json && npm install

# Check for duplicates
npm dedupe --dry-run
```

---

## START NOW

1. Run npm audit for security
2. Run npm outdated for updates
3. Analyze dependency tree
4. Check for duplicates and unused
5. Plan update order (security first)
6. Apply updates incrementally
7. Verify after each update
8. Produce dependency report
9. Update session state

**Remember: Security first, one update at a time, verify after each.**
