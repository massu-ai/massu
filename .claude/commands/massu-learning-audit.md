---
name: massu-learning-audit
description: Validate auto-learning effectiveness - memory coverage, pattern scanner coverage, failure recurrence
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-learning-audit

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# Massu Learning Audit: Auto-Learning Effectiveness Validation

## Objective

Validate that the auto-learning protocol is working effectively by checking:
1. Memory coverage for each canonical rule (CR)
2. Pattern scanner coverage for each documented issue
3. Failure recurrence rates
4. Session quality statistics

**Philosophy**: Every issue that recurs is evidence that auto-learning failed. This audit proves the learning system is working.

---

## NON-NEGOTIABLE RULES

- **Proof > Claims** - Show tool output, not summaries
- **Every CR must have coverage** - CRs without scanner checks = learning gaps
- **Every incident must have scanner rule** - Issues without grep checks recur
- **Zero tolerance for recurrence** - Any recurring issue is a learning failure
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - If any learning gap is discovered, fix it immediately by adding the missing scanner rule or memory entry.

---

## Section 1: Pattern Scanner Coverage Check

**For each canonical rule (CR-1 through CR-12), verify the pattern scanner catches violations.**

### 1.1 Verify Pattern Scanner Exists and Runs

```bash
# Verify pattern-scanner.sh exists and is executable
ls -la scripts/massu-pattern-scanner.sh

# Run pattern scanner
bash scripts/massu-pattern-scanner.sh
```

### 1.2 Verify Key Patterns Are Checked

```bash
# CR-2: File/module structure assumptions
grep -c "import\|\.ts" scripts/massu-pattern-scanner.sh

# CR-11: Tool registration
grep -c "tools\.ts\|ToolDefinition\|registration" scripts/massu-pattern-scanner.sh

# CR-12: Hook compilation
grep -c "hook\|build:hooks" scripts/massu-pattern-scanner.sh

# Config-driven patterns
grep -c "getConfig\|hardcoded\|massu_" scripts/massu-pattern-scanner.sh

# ESM compliance
grep -c "\.ts\|extension" scripts/massu-pattern-scanner.sh
```

### 1.3 Scanner Coverage Report

| CR | Rule Summary | Scanner Check Exists | Status |
|----|-------------|---------------------|--------|
| CR-1 | Verify don't claim | N/A (behavioral) | - |
| CR-2 | Never assume structure | Check required | - |
| CR-3 | Never commit secrets | Check required | - |
| CR-4 | Verify removals | N/A (behavioral) | - |
| CR-9 | Fix all issues | N/A (behavioral) | - |
| CR-11 | Tool registration | Check required | - |
| CR-12 | Hook compilation | Check required | - |

**Expected**: All automatable CRs have scanner checks.

---

## Section 2: Security Scanner Coverage

### 2.1 Verify Security Scanner Exists and Runs

```bash
# Verify security-scanner.sh exists and is executable
ls -la scripts/massu-security-scanner.sh

# Run security scanner
bash scripts/massu-security-scanner.sh
```

### 2.2 Verify Security Patterns Are Checked

```bash
# Secrets detection
grep -c "secret\|credential\|api.key\|password" scripts/massu-security-scanner.sh

# Unsafe patterns
grep -c "eval\|exec\|prototype" scripts/massu-security-scanner.sh

# @ts-ignore/@ts-nocheck
grep -c "ts-ignore\|ts-nocheck" scripts/massu-security-scanner.sh
```

### 2.3 Security Scanner Coverage Report

| Check | Pattern | Scanner Check Exists | Status |
|-------|---------|---------------------|--------|
| Hardcoded secrets | API keys, passwords | Check required | - |
| Unsafe eval | eval/exec usage | Check required | - |
| Type bypass | @ts-ignore, @ts-nocheck | Check required | - |
| Prototype pollution | prototype as key | Check required | - |

**Expected**: All security-critical patterns have scanner checks.

---

## Section 3: Session State Coverage

### 3.1 Verify Session State File

```bash
# Check session state exists
ls -la .claude/session-state/CURRENT.md

# Check for recent updates
cat .claude/session-state/CURRENT.md | head -20
```

### 3.2 Check for Documented Decisions and Failures

```bash
# Verify decisions are recorded
grep -c "decision\|Decision\|DECISION" .claude/session-state/CURRENT.md 2>/dev/null || echo "0"

# Verify failures are recorded
grep -c "fail\|Fail\|FAIL\|error\|Error" .claude/session-state/CURRENT.md 2>/dev/null || echo "0"
```

---

## Section 4: MCP Tool Memory Coverage

### 4.1 Check Memory Tools Exist

```bash
# Verify memory tools are available
grep -rn "memory_ingest\|memory_search\|memory_failures" packages/core/src/ --include="*.ts" | grep -v __tests__ | head -10
```

### 4.2 Query Memory for CR Coverage

If MCP memory tools are available, query for each major CR:

| CR | Rule Summary | Memory Entries Found | Status |
|----|-------------|---------------------|--------|
| CR-9 | Fix all issues | Query required | - |
| CR-11 | Tool registration | Query required | - |
| CR-12 | Hook compilation | Query required | - |

**Expected**: Every critical CR has >= 1 memory entry.

---

## Section 5: Failure Recurrence Analysis

### 5.1 Check for Recurring Patterns

```bash
# Look for patterns that have been fixed multiple times
grep -rn "FIXME\|TODO\|HACK\|WORKAROUND" packages/core/src/ --include="*.ts" | grep -v __tests__

# Check git log for repeated fix patterns
git log --oneline -20 2>/dev/null | grep -i "fix\|bug\|patch" || echo "No git history"
```

### 5.2 Recurrence Report

| Pattern | First Occurrence | Recurrence Count | Status |
|---------|-----------------|------------------|--------|
| Query required | - | - | - |

**Expected**: recurrence_count == 0 for all patterns (no recurrences).

---

## Section 6: Gap Report & Remediation

### 6.1 CRs Without Scanner Coverage

List all CRs from Section 1 with no scanner check.

### 6.2 Issues Without Scanner Rules

List all known issues from Section 2 with no scanner check.

### 6.3 Remediation Steps

For each gap found:

**Missing Scanner Rule**: Add to `scripts/massu-pattern-scanner.sh`:
```bash
# Add grep check for the bad pattern
grep -rn "[bad_pattern]" packages/core/src/ && echo "VIOLATION: [description]" && exit 1
```

**Missing Memory Entry**: If MCP memory tools are available, ingest the pattern.

**Missing Session State**: Update `.claude/session-state/CURRENT.md` with the finding.

---

## Section 7: Verification Gate

### 7.1 Run All Scanners

```bash
# Pattern scanner
bash scripts/massu-pattern-scanner.sh

# Security scanner
bash scripts/massu-security-scanner.sh

# Type check
cd packages/core && npx tsc --noEmit

# Tests
npm test

# Hook compilation
cd packages/core && npm run build:hooks
```

### 7.2 Comprehensive Verification Report

| Check | Command | Result | Status |
|-------|---------|--------|--------|
| Pattern scanner | `bash scripts/massu-pattern-scanner.sh` | Exit code | PASS/FAIL |
| Security scanner | `bash scripts/massu-security-scanner.sh` | Exit code | PASS/FAIL |
| Type check | `cd packages/core && npx tsc --noEmit` | Error count | PASS/FAIL |
| Tests | `npm test` | Pass/fail count | PASS/FAIL |
| Hook build | `cd packages/core && npm run build:hooks` | Exit code | PASS/FAIL |

---

## Completion Criteria

- [ ] All automatable CRs have pattern scanner checks
- [ ] All security patterns have scanner checks
- [ ] Pattern scanner exits 0
- [ ] Security scanner exits 0
- [ ] Session state is current
- [ ] No recurring failure patterns found
- [ ] All gaps remediated
- [ ] Type check passes
- [ ] All tests pass
- [ ] Hooks compile

**Remember: Auto-learning is not optional. Every issue that recurs proves the learning system failed.**
