---
name: massu-test
description: Intelligent test runner with failure analysis, coverage gaps, and test generation
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-test

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# CS Test: Intelligent Test Runner

## Objective

Run tests intelligently, analyze failures, detect coverage gaps, and generate missing tests. Supports multiple modes for targeted testing workflows.

**Usage**: `/massu-test` (run all) or `/massu-test [--affected | --coverage | --generate [module] | --fix]`

## Workflow Position

```
/massu-test                    (standalone test runner)
/massu-test --fix              (test + auto-fix failures)
/massu-test --generate [mod]   (generate missing tests)
/massu-test --coverage         (coverage analysis)
/massu-test --affected          (only tests for changed files)
```

---

## NON-NEGOTIABLE RULES

- Always capture FULL test output (do not truncate)
- Never modify source code unless in `--fix` or `--generate` mode
- In `--fix` mode: understand WHY before applying any fix
- In `--generate` mode: follow vitest patterns from existing tests exactly
- Report ALL failures, not just the first one
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** — in `--fix` mode, fix every failing test, not just one
- **VR-TEST verification** — `npm test` must pass before commit
- **Critical paths first** — Tool handlers, config parsing, DB operations need tests
- **Isolation** — Tests must not depend on external state
- **Deterministic** — Same code = same result

---

## ZERO-GAP AUDIT LOOP

**Test audit does NOT complete until a SINGLE COMPLETE AUDIT finds ZERO issues.**

### The Rule

```
TEST AUDIT LOOP:
  1. Run ALL test coverage and quality checks
  2. Count gaps and issues found
  3. IF issues > 0:
       - Fix ALL issues (add tests, fix anti-patterns)
       - Re-run ENTIRE audit from Step 1
  4. IF issues == 0:
       - TEST COVERAGE VERIFIED
```

### Completion Requirement

| Scenario | Action |
|----------|--------|
| Audit finds 3 untested critical paths | Add tests, re-run ENTIRE audit |
| Re-audit finds 1 test quality issue | Fix it, re-run ENTIRE audit |
| Re-audit finds 0 issues | **NOW** test coverage verified |

**Partial re-checks are NOT valid. The ENTIRE test audit must pass in a SINGLE run.**

---

## STEP 1: DETERMINE MODE

Parse `$ARGUMENTS` to determine the execution mode:

| Argument | Mode | Description |
|----------|------|-------------|
| (none) | FULL_RUN | Run all tests, report results with analysis |
| `--affected` | AFFECTED | Run only tests affected by current git diff |
| `--coverage` | COVERAGE | Run tests + analyze which modules have no test coverage |
| `--generate [module]` | GENERATE | Generate test file for specified module |
| `--fix` | FIX | Run tests, auto-fix failing tests |

```
IF no arguments:
  MODE = FULL_RUN
ELSE IF arguments contain "--affected":
  MODE = AFFECTED
ELSE IF arguments contain "--coverage":
  MODE = COVERAGE
ELSE IF arguments contain "--generate":
  MODE = GENERATE
  TARGET_MODULE = [module name from arguments]
ELSE IF arguments contain "--fix":
  MODE = FIX
ELSE:
  OUTPUT: "Unknown mode. Usage: /massu-test [--affected | --coverage | --generate [module] | --fix]"
  ABORT
```

---

## STEP 2: RUN TESTS

```bash
# Run the full test suite with output capture
npm test 2>&1
```

**For AFFECTED mode, skip to STEP 6 first, then run only affected tests.**

---

## STEP 3: ANALYZE RESULTS

Parse vitest output to extract metrics:

```markdown
### Test Results

| Metric | Value |
|--------|-------|
| Total tests | [N] |
| Passing | [N] |
| Failing | [N] |
| Skipped | [N] |
| Duration | [N]s |
| Test files | [N] |
```

**If all tests pass and mode is FULL_RUN:** Proceed to STEP 5 (coverage gap analysis) then COMPLETION REPORT.

**If any tests fail:** Proceed to STEP 4.

---

## STEP 4: FAILURE ANALYSIS

**For each failing test:**

1. **Read the test file** — Understand what the test expects
2. **Read the source module** it tests — Understand what the code actually does
3. **Identify root cause** — Compare expected vs actual behavior

### Classification

For each failure, classify as one of:

| Classification | Meaning | Fix Target |
|----------------|---------|------------|
| TEST_BUG | Test assertion is incorrect or outdated | Test file |
| CODE_BUG | Source code has an actual bug | Source file |
| STALE | Test references removed/renamed code | Test file |
| MOCK_ISSUE | Mock is incorrect or missing | Test file |
| ENV_ISSUE | Environment/setup problem | Test config |

```markdown
### Failure Analysis

| Test | File | Classification | Root Cause | Fix Target |
|------|------|---------------|------------|------------|
| [test name] | [file:line] | [class] | [description] | [file] |
```

### FIX Mode (if `--fix`)

For each failing test (ordered by classification priority: CODE_BUG > TEST_BUG > STALE > MOCK_ISSUE):

1. **Apply the minimal correct fix** following CLAUDE.md patterns
2. **Re-run the specific test file** to verify the fix:
   ```bash
   npx vitest run [specific test file] 2>&1
   ```
3. **If still failing:** Re-analyze and retry (max 3 attempts per test)
4. **After all fixes applied:** Run the full suite to verify no regressions:
   ```bash
   npm test 2>&1
   ```

```
FIX LOOP:
  FOR EACH failing_test:
    attempts = 0
    WHILE test fails AND attempts < 3:
      - Read test + source
      - Apply fix
      - Re-run specific test
      - attempts++
    IF still failing after 3 attempts:
      - Mark as MANUAL_FIX_NEEDED
      - Continue to next test
  AFTER all fixes:
    - Run full suite: npm test
    - IF new failures introduced: REVERT last fix, investigate
```

---

## STEP 5: COVERAGE GAP ANALYSIS

**Runs in FULL_RUN and COVERAGE modes.**

### Core Package Coverage

```bash
# List all source modules (excluding tests, hooks, type-only files)
ls packages/core/src/*.ts

# List all test files
ls packages/core/src/__tests__/*.test.ts
```

Cross-reference: for each source module, check if a corresponding test file exists.

```markdown
### Core Package Coverage

| Source Module | Test File | Status |
|--------------|-----------|--------|
| analytics.ts | analytics.test.ts | COVERED / MISSING |
| config.ts | config.test.ts | COVERED / MISSING |
| ... | ... | ... |

**Coverage: [X]/[Y] modules ([Z]%)**
```

### Package Coverage (other packages)

```bash
# List other package modules
ls packages/plugin/src/*.ts 2>/dev/null
ls packages/shared/src/*.ts 2>/dev/null
```

```markdown
### Package Coverage

| Source Module | Test File | Status |
|--------------|-----------|--------|
| [module] | [test] | COVERED / MISSING |

**Coverage: [X]/[Y] modules ([Z]%)**
```

### Coverage Verdict

| Threshold | Status |
|-----------|--------|
| >= 80% modules covered | GOOD |
| 50-79% modules covered | NEEDS IMPROVEMENT |
| < 50% modules covered | POOR |

---

## STEP 6: AFFECTED TEST DETECTION

**Runs in AFFECTED mode only.**

### 6a. Get Changed Files

```bash
# Get files changed vs HEAD (unstaged + staged)
git diff --name-only HEAD
git diff --cached --name-only
```

### 6b. Trace to Test Files

For each changed source file in `packages/core/src/`:

```bash
# Find test files that import or reference this module
grep -rl "[module-name]" packages/core/src/__tests__/ --include="*.test.ts"
```

### 6c. Run Affected Tests Only

```bash
# Run only the affected test files
npx vitest run [affected-test-file-1] [affected-test-file-2] ... 2>&1
```

```markdown
### Affected Test Detection

| Changed File | Affected Tests | Result |
|-------------|---------------|--------|
| [source file] | [test files] | PASS/FAIL |

**[N] changed files -> [M] affected test files -> [P] passing, [F] failing**
```

---

## STEP 7: TEST GENERATION

**Runs in GENERATE mode only.**

### 7a. Read the Target Module

```bash
# Read the module to be tested
cat packages/core/src/[module].ts
```

Understand:
- All exported functions
- Function signatures and return types
- Dependencies (imports)
- Database usage (which DB: CodeGraph, Data, Memory)

### 7b. Read a Pattern Reference Test

Find and read an existing test for a similar module:

```bash
# Find a test for a module of similar type
ls packages/core/src/__tests__/*.test.ts
```

**For 3-function tool modules** (analytics, cost-tracker, etc.): use `observability-tools.test.ts` as pattern reference.
**For utility modules**: use `config.test.ts` or similar as pattern reference.

### 7c. Generate the Test File

Generate following vitest patterns:
- `import { describe, it, expect, beforeEach, afterEach } from 'vitest'`
- `describe('[module name]', () => { ... })`
- `it('should [behavior]', () => { ... })`
- In-memory database setup in `beforeEach` / cleanup in `afterEach`

**For 3-function tool modules, test all three functions:**

```typescript
// 1. Test getXToolDefinitions()
describe('getXToolDefinitions', () => {
  it('should return tool definitions with correct names', () => { ... });
  it('should include required input schemas', () => { ... });
});

// 2. Test isXTool()
describe('isXTool', () => {
  it('should return true for matching tool names', () => { ... });
  it('should return false for non-matching tool names', () => { ... });
});

// 3. Test handleXToolCall()
describe('handleXToolCall', () => {
  it('should handle [action] correctly', () => { ... });
  it('should return error for unknown tool', () => { ... });
});
```

### 7d. Write and Verify

```bash
# Write the test file
# Path: packages/core/src/__tests__/[module].test.ts

# Run the new test
npx vitest run packages/core/src/__tests__/[module].test.ts 2>&1
```

**If the new test fails:**
1. Read the error output carefully
2. Fix the test (NOT the source code — unless it reveals an actual bug)
3. Re-run until passing
4. Run full suite to verify no regressions: `npm test`

---

## VERIFICATION GATES

After any modifications (--fix or --generate modes):

### Gate 1: All Tests Pass (VR-TEST)
```bash
npm test
# MUST exit 0, all tests pass
```

### Gate 2: Type Safety (VR-TYPE)
```bash
cd packages/core && npx tsc --noEmit
# MUST show 0 errors
```

### Gate 3: Pattern Compliance (VR-PATTERN)
```bash
bash scripts/massu-pattern-scanner.sh
# MUST exit 0
```

**If ANY gate fails:** Fix the issue, re-run ALL gates. Repeat until clean.

---

## TEST QUALITY AUDIT

### Check for Anti-Patterns
```bash
# Find tests without assertions
grep -rn "it(.*{" packages/core/src/__tests__/ | grep -v "expect\|assert" | head -10

# Find tests with only console.log
grep -rn "console.log" packages/core/src/__tests__/ | head -10

# Find flaky patterns (setTimeout, random)
grep -rn "setTimeout\|Math.random" packages/core/src/__tests__/ | head -10
```

### Test Quality Matrix
```markdown
### Test Quality Audit

| Issue | Files Affected | Severity | Fix |
|-------|---------------|----------|-----|
| No assertions | N | HIGH | Add expects |
| Flaky patterns | N | MEDIUM | Refactor |
| console.log in tests | N | LOW | Remove |
```

---

## SESSION STATE UPDATE

After test audit, update `session-state/CURRENT.md`:

```markdown
## TEST AUDIT SESSION

### Audit
- **Date**: [timestamp]
- **Scope**: Full / [specific area]
- **Mode**: [FULL_RUN / AFFECTED / COVERAGE / GENERATE / FIX]

### Findings
- Total test files: [N]
- Total tests: [N]
- Coverage: [X]% modules with tests
- Quality issues: [N]

### Tests Added/Fixed
[List or "None - audit only"]

### Status
- VR-TEST: PASS/FAIL
- Coverage target: MET/NOT MET
```

---

## AUTO-LEARNING PROTOCOL (MANDATORY after every fix/finding)

After EVERY fix or finding during test audit:

### Step 1: Record the Pattern
Update `.claude/session-state/CURRENT.md` with:
- What was wrong (the incorrect pattern or missing test)
- What fixed it (the correct pattern)
- File(s) affected

### Step 2: Add to Pattern Scanner (if grep-able)
If the bad pattern is detectable by grep, consider adding it to `scripts/massu-pattern-scanner.sh`.

### Step 3: Search Codebase-Wide (CR-9)
```bash
grep -rn "[bad_pattern]" packages/core/src/ --include="*.ts"
```
Fix ALL instances found, not just the one that was reported.

---

## COMPLETION REPORT

```markdown
## CS TEST COMPLETE

### Mode: [FULL_RUN / AFFECTED / COVERAGE / GENERATE / FIX]

### Test Results
| Metric | Value |
|--------|-------|
| Total tests | [N] |
| Passing | [N] |
| Failing | [N] |
| Duration | [N]s |

### Failure Analysis (if any)
| Test | Classification | Root Cause | Fixed? |
|------|---------------|------------|--------|
| [name] | [class] | [cause] | YES/NO/MANUAL |

### Coverage Gaps (if analyzed)
| Area | Covered | Total | Percentage |
|------|---------|-------|------------|
| Core | [N] | [N] | [N]% |
| Website | [N] | [N] | [N]% |

### Generated Tests (if any)
| Module | Test File | Tests | Status |
|--------|-----------|-------|--------|
| [module] | [file] | [N] tests | PASSING |

### Verification Gates (if modifications made)
| Gate | Status |
|------|--------|
| Tests (VR-TEST) | PASS |
| Types (VR-TYPE) | PASS |
| Patterns (VR-PATTERN) | PASS |

### Next Steps
- [Actionable recommendations based on findings]
```
