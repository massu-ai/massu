---
name: massu-push
description: Full verification gate (all tests, regression detection, security) before remote push
allowed-tools: Bash(*), Read(*), Edit(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# CS Push: Full Verification Gate Before Remote Push

## Objective

Execute COMPREHENSIVE verification including ALL tests and security checks before pushing to remote. This is the final gate - code MUST pass every check before leaving your machine.

**Philosophy**: Commit often (quality checks), push verified (full checks + security + regression).

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state**

Update `session-state/CURRENT.md` to include `AUTHORIZED_COMMAND: massu-push`.

---

## NON-NEGOTIABLE RULES

- **ALL tests must pass** - vitest, full suite
- **ALL security checks must pass** - npm audit, secrets scan
- **Zero violations** - Pattern scanner, type check
- **Do NOT push if ANY check fails**
- **Document ALL test failures before fixing**
- **Regression detection MANDATORY** - Compare against main branch
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - Pre-existing or not

---

## CRITICAL: DUAL VERIFICATION REQUIREMENT

**Push completion requires BOTH verification gates to pass.**

| Verification | What It Checks | Required for Push |
|--------------|----------------|-------------------|
| **Code Quality** | Build, types, patterns, tests pass | YES |
| **Plan Coverage** | ALL plan items implemented (if from plan) | YES |

**Code Quality: PASS + Plan Coverage: FAIL = DO NOT PUSH**

---

## CRITICAL: REGRESSION DETECTION

**Before pushing, verify no existing tests have regressed.**

### Regression Detection Protocol

#### Step 1: Establish Baseline
```bash
# If on main branch, compare against parent commit instead
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" = "main" ]; then
  # Compare against parent commit
  git stash -q 2>/dev/null || true
  git checkout HEAD~1 -q
  npm test 2>&1 | tee /tmp/baseline-tests.txt
  git checkout - -q
  git stash pop -q 2>/dev/null || true
else
  # Compare against main branch
  git stash -q 2>/dev/null || true
  git checkout main -q
  npm test 2>&1 | tee /tmp/baseline-tests.txt
  git checkout - -q
  git stash pop -q 2>/dev/null || true
fi
```

#### Step 2: Run Tests on Current Branch
```bash
npm test 2>&1 | tee /tmp/current-tests.txt
```

#### Step 3: Compare Results
```bash
# Parse vitest output: "Tests  N passed (N)" or "Tests  N failed | N passed (N)"
BASELINE_PASS=$(sed -n 's/.*Tests[[:space:]]*\([0-9]*\)[[:space:]]*passed.*/\1/p' /tmp/baseline-tests.txt | head -1)
[ -z "$BASELINE_PASS" ] && BASELINE_PASS=0
BASELINE_FAIL=$(sed -n 's/.*\([0-9]*\)[[:space:]]*failed.*/\1/p' /tmp/baseline-tests.txt | head -1)
[ -z "$BASELINE_FAIL" ] && BASELINE_FAIL=0

CURRENT_PASS=$(sed -n 's/.*Tests[[:space:]]*\([0-9]*\)[[:space:]]*passed.*/\1/p' /tmp/current-tests.txt | head -1)
[ -z "$CURRENT_PASS" ] && CURRENT_PASS=0
CURRENT_FAIL=$(sed -n 's/.*\([0-9]*\)[[:space:]]*failed.*/\1/p' /tmp/current-tests.txt | head -1)
[ -z "$CURRENT_FAIL" ] && CURRENT_FAIL=0

echo "Baseline: $BASELINE_PASS passed, $BASELINE_FAIL failed"
echo "Current:  $CURRENT_PASS passed, $CURRENT_FAIL failed"
```

#### Step 4: Gate Decision
| Scenario | Action |
|----------|--------|
| No regressions | PASS - Continue to push |
| Regressions found | FAIL - Fix before push |
| New test failures | Investigate - may be new test or bug |

```markdown
### Regression Detection Report

| Metric | Value |
|--------|-------|
| Baseline (main) passing tests | [N] |
| Current branch passing tests | [N] |
| Regressions (was passing, now failing) | [N] |

**REGRESSION GATE: PASS / FAIL**
```

---

## VERIFICATION TIERS

### Tier 1: Quick Checks (should already pass from massu-commit)

```bash
# 1.1 Pattern Scanner
bash scripts/massu-pattern-scanner.sh
# MUST exit 0

# 1.2 TypeScript
cd packages/core && npx tsc --noEmit
# MUST show 0 errors

# 1.3 Hook Build
cd packages/core && npm run build:hooks
# MUST exit 0
```

**Gate Check:**
```markdown
### Tier 1: Quick Checks
| Check | Command | Result | Status |
|-------|---------|--------|--------|
| Pattern Scanner | massu-pattern-scanner.sh | Exit [X] | PASS/FAIL |
| TypeScript | tsc --noEmit | [X] errors | PASS/FAIL |
| Hook Build | build:hooks | Exit [X] | PASS/FAIL |

**Tier 1 Status: PASS/FAIL**
```

---

### Tier 2: Full Test Suite (CRITICAL)

#### 2.0 Regression Detection (MANDATORY FIRST)

Run the regression detection protocol above before the full test suite.

#### 2.1 All Tests (vitest)
```bash
npm test
# MUST exit 0, all tests pass
```

Capture output:
- Total tests
- Passed tests
- Failed tests
- Skipped tests

**If tests fail:**
1. Document ALL failures
2. Fix each failure
3. Re-run ALL tests (not just failed ones)

#### 2.2 Tool Registration Verification (if new tools in this push)

```bash
# List new/modified tool files
git diff origin/main..HEAD --name-only | grep "tools\|tool"

# For EACH new tool, verify registration
grep "getToolDefinitions\|isToolName\|handleToolCall" packages/core/src/tools.ts
```

**Gate Check:**
```markdown
### Tier 2: Test Suite
| Check | Command | Passed | Failed | Status |
|-------|---------|--------|--------|--------|
| Regression Detection | Compare vs main | 0 regressions | 0 | PASS/FAIL |
| All Tests | npm test | [X]/[Y] | 0 | PASS/FAIL |
| Tool Registration | grep tools.ts | All registered | 0 | PASS/FAIL |

**Tier 2 Status: PASS/FAIL**
```

---

### Tier 3: Security & Compliance

#### 3.1 npm Audit
```bash
npm audit --audit-level=high
# MUST have 0 high/critical vulnerabilities
```

**Vulnerability Handling:**
- **Critical/High**: MUST fix before push
- **Moderate**: Document and create ticket
- **Low**: Informational only

#### 3.2 Secrets Scan
```bash
# Check for staged secret files
git diff --cached --name-only | grep -E '\.(env|pem|key|secret)' && echo "FAIL" || echo "PASS"

# Check for hardcoded credentials in source
grep -rn 'sk-[a-zA-Z0-9]\{20,\}\|password.*=.*["\x27][^"\x27]\{8,\}' --include="*.ts" --include="*.tsx" \
  packages/core/src/ 2>/dev/null \
  | grep -v "process.env" \
  | grep -v 'RegExp\|regex\|REDACT\|redact\|sanitize\|mask' \
  | grep -v '\.test\.ts:' \
  | wc -l
# MUST be 0
```

#### 3.3 License Compliance (if deps changed)
```bash
# Check if package.json or package-lock.json changed
git diff origin/main..HEAD --name-only | grep -E 'package(-lock)?\.json' && \
  npm audit --audit-level=high 2>&1 || true
```

#### 3.3 Plan Coverage (if from plan)
```markdown
### Plan Coverage Verification

| Item # | Description | Status | Proof |
|--------|-------------|--------|-------|
| P1-001 | [desc] | DONE | [evidence] |
| ... | ... | ... | ... |

**Coverage: X/X items = 100%**
```

**Gate Check:**
```markdown
### Tier 3: Security & Compliance
| Check | Command | Result | Status |
|-------|---------|--------|--------|
| npm audit | npm audit --audit-level=high | [X] vulns | PASS/FAIL |
| Secrets Scan | grep check | [X] found | PASS/FAIL |
| Plan Coverage | item-by-item | [X]/[X] = [X]% | PASS/FAIL |

**Tier 3 Status: PASS/FAIL**
```

---

### Tier 4: Business Logic Verification

```bash
# Run integration tests
npm run test:integration

# Verify tooling self-test
bash scripts/massu-verify-tooling.sh
```

**Gate Check:**
```markdown
### Tier 4: Business Logic
| Check | Command | Pass Criteria | Status |
|-------|---------|---------------|--------|
| Integration tests | npm run test:integration | All tests pass | PASS/FAIL |
| Tooling self-test | massu-verify-tooling.sh | Exit 0 | PASS/FAIL |

**Tier 4 Status: PASS/FAIL**
```

---

## EXECUTION FLOW

### Phase 1: Pre-Flight Verification

```bash
# Verify we're on a branch and have commits to push
git status
git log origin/main..HEAD --oneline
```

If no commits to push, abort with message.

### Phase 2: Run All Tiers

Run Tier 1, Tier 2, Tier 3, and Tier 4 in order. Stop at first tier failure.

### Phase 3: Final Gate & Push

#### All Tiers Must Pass

```markdown
### PUSH GATE SUMMARY
| Tier | Description | Status |
|------|-------------|--------|
| Tier 1 | Quick Checks (patterns, types, hooks) | PASS/FAIL |
| Tier 2 | Full Test Suite + Regression | PASS/FAIL |
| Tier 3 | Security & Compliance | PASS/FAIL |
| Tier 4 | Business Logic Verification | PASS/FAIL |

### DUAL VERIFICATION GATE
| Gate | Status | Evidence |
|------|--------|----------|
| Code Quality | PASS/FAIL | Tiers 1-4 |
| Plan Coverage | PASS/FAIL | X/X items (if plan) |

**OVERALL: PASS / FAIL**
```

#### If ALL Pass

```bash
# Push to remote
git push origin [current-branch]
```

#### If ANY Fail

1. **Document ALL failures**
2. **Fix each failure**
3. **Re-run ENTIRE verification** (not just failed tiers)
4. **Do NOT push until all tiers pass**

---

## AUTO-LEARNING PROTOCOL

After pushing, if any issues were fixed during this verification:

1. **Record the pattern** - What went wrong and how it was fixed
2. **Check if pattern scanner should be updated**
3. **Update session state**

---

## COMPLETION REPORT

```markdown
## CS PUSH COMPLETE

### Push Details
- **Branch**: [branch]
- **Commits**: [count]
- **Remote**: origin/[branch]

### Verification Summary
| Tier | Checks | Status |
|------|--------|--------|
| Tier 1 | Patterns, Types, Hooks | PASS |
| Tier 2 | Tests ([X] passed), Regression (0) | PASS |
| Tier 3 | npm audit (0 high/critical), Secrets (0) | PASS |

### Dual Verification
| Gate | Status |
|------|--------|
| Code Quality | PASS |
| Plan Coverage | PASS (X/X = 100%) |

**Push succeeded.**
```
