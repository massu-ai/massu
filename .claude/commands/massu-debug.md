---
name: massu-debug
description: Systematic debugging with hypothesis testing, root cause tracing, and verified fixes
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# CS Debug: Systematic Debugging Protocol

## Objective

Trace errors to root cause systematically using hypothesis-driven investigation. Never guess — read the code, form hypotheses, test them, and verify fixes don't break anything else.

**Usage**: `/massu-debug [error description, test name, or stack trace]`

---

## NON-NEGOTIABLE RULES

- **Never guess the root cause** — read the code
- **Never apply a fix without understanding WHY it works**
- **Always verify the fix doesn't break other tests**
- **Record each hypothesis and its outcome**
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** — if you find additional bugs while debugging, fix those too
- **Proof > reasoning. Commands > assumptions.**

---

## STEP 0: MEMORY CHECK

Before investigating, search for past failures related to this issue:

- Check session state (`.claude/session-state/CURRENT.md`) for recent failures
- Search codebase for similar error patterns
- Check if this is a known issue with an established fix pattern

If matches found: read the previous failures and avoid repeating failed approaches.

---

## STEP 1: SYMPTOM CAPTURE

Record the exact error from `$ARGUMENTS`:

```markdown
### Symptom
- **Error**: [exact error message or test name]
- **Stack trace**: [if provided]
- **Unexpected behavior**: [what happened vs what was expected]
- **Reproducible**: [how to reproduce — test command, user action, etc.]
```

**If `$ARGUMENTS` is a test name:**
```bash
# Run the specific test to capture the full error
npx vitest run [test-file-or-pattern] 2>&1
```

**If `$ARGUMENTS` is an error message:**
```bash
# Search for the error message in the codebase
grep -rn "[error message]" packages/core/src/ --include="*.ts" --include="*.tsx"
```

**If `$ARGUMENTS` is vague or missing:**
```
OUTPUT: "Please provide one of: (1) exact error message, (2) failing test name, (3) stack trace, (4) steps to reproduce"
ABORT
```

---

## STEP 2: LOCATE ERROR SOURCE

### From Stack Trace

Parse the stack trace for the originating file and line number:

```bash
# Read the file at the error location with 50 lines of surrounding context
# (25 lines before, 25 lines after the error line)
```

### From Error Message

```bash
# Grep for the error message string in source code
grep -rn "[error message text]" packages/core/src/ --include="*.ts"
# Also search in other package directories if applicable
grep -rn "[error message text]" packages/ --include="*.ts" --include="*.tsx"
```

### From Test Failure

```bash
# Read the failing test to understand what it expects
# Read the source module the test imports
```

```markdown
### Error Location
- **File**: [file path]
- **Line**: [line number]
- **Function**: [function name]
- **Context**: [what this code is supposed to do]
```

---

## STEP 3: TRACE CALL CHAIN

Follow function calls upstream to understand the full execution path:

```bash
# Find who calls this function
grep -rn "[function_name](" packages/core/src/ --include="*.ts"

# Find what arguments are passed
# Read each caller to understand the data flow
```

Build the call chain:

```markdown
### Call Chain
```
caller_1() [file_1.ts:NN]
  → caller_2() [file_2.ts:NN]
    → error_site() [file_3.ts:NN]  ← ERROR HERE
```

### Data Flow
| Step | Variable | Value/Type | Source |
|------|----------|------------|--------|
| 1 | [var] | [value/type] | [where it comes from] |
| 2 | [var] | [value/type] | [transformation] |
| 3 | [var] | [unexpected value] | ← MISMATCH |
```

---

## STEP 4: HYPOTHESIS FORMATION

Based on code reading (NOT guessing), form up to 3 ranked hypotheses:

```markdown
### Hypotheses

| # | Hypothesis | Confidence | Verification Method |
|---|-----------|------------|---------------------|
| H1 | [most likely cause based on code reading] | HIGH/MED/LOW | [specific command or check to verify] |
| H2 | [alternative cause] | HIGH/MED/LOW | [specific command or check to verify] |
| H3 | [least likely cause] | HIGH/MED/LOW | [specific command or check to verify] |
```

**Hypothesis quality requirements:**
- Each hypothesis must be based on SPECIFIC code you read (cite file:line)
- Each verification method must be a CONCRETE action (bash command, grep, read specific file)
- "Something might be wrong" is NOT a valid hypothesis

---

## STEP 5: HYPOTHESIS TESTING

Test hypotheses in order of confidence (highest first):

```
FOR EACH hypothesis (highest confidence first):
  1. Execute the verification method
  2. Record the result
  3. IF confirmed → proceed to STEP 6
  4. IF rejected → record why and test next hypothesis

IF all hypotheses rejected:
  - Expand search scope
  - Read more files in the call chain
  - Check for environmental factors (config, DB state, imports)
  - Form new hypotheses and repeat from STEP 4
```

```markdown
### Hypothesis Testing Results

| # | Hypothesis | Verification | Result | Outcome |
|---|-----------|-------------|--------|---------|
| H1 | [hypothesis] | [what you did] | [what you found] | CONFIRMED / REJECTED |
| H2 | [hypothesis] | [what you did] | [what you found] | CONFIRMED / REJECTED |
| H3 | [hypothesis] | [what you did] | [what you found] | CONFIRMED / REJECTED |
```

---

## STEP 6: ROOT CAUSE DOCUMENTATION

Document the confirmed root cause before applying any fix:

```markdown
### Root Cause

- **What**: [precise description of the bug]
- **Why**: [why this bug exists — missing check, wrong assumption, stale code, etc.]
- **Where**: [file(s) and line(s) affected]
- **When introduced**: [if determinable — recent commit, original code, etc.]
- **Blast radius**: [what else could be affected by this bug and by the fix]
```

---

## STEP 7: APPLY FIX

### Scope Check

```
IF fix touches > 5 files:
  OUTPUT: "Fix scope is large ([N] files). Consider using /massu-create-plan for a structured approach."
  ASK user whether to proceed or create a plan
```

### Apply the Fix

1. **Apply the minimal correct fix** following CLAUDE.md patterns
2. **Document what was changed and why**
3. **Do NOT make unrelated improvements** — fix the bug only

```markdown
### Fix Applied

| File | Change | Reason |
|------|--------|--------|
| [file:line] | [what was changed] | [why this fixes the root cause] |
```

---

## STEP 8: VERIFY FIX

### 8a. Targeted Test (if exists)

```bash
# Run the originally-failing test
npx vitest run [test file] 2>&1
```

**Must pass.** If it still fails, go back to STEP 4 with new information.

### 8b. Full Test Suite (VR-TEST)

```bash
npm test 2>&1
# MUST exit 0, ALL tests pass
```

### 8c. Type Check (VR-TYPE)

```bash
cd packages/core && npx tsc --noEmit
# MUST show 0 errors
```

### 8d. Pattern Scanner (VR-PATTERN)

```bash
bash scripts/massu-pattern-scanner.sh
# MUST exit 0
```

### 8e. Hook Build (VR-HOOK-BUILD, if hooks modified)

```bash
cd packages/core && npm run build:hooks
# MUST exit 0
```

**If ANY verification fails:**
1. Investigate the new failure
2. Determine if it was caused by the fix or is pre-existing
3. Fix it (CR-9: fix ALL issues encountered)
4. Re-run ALL verification from 8a

---

## STEP 9: RECORD FOR LEARNING

Update session state with the debugging outcome:

```bash
# Update .claude/session-state/CURRENT.md with:
# - Bug description
# - Root cause
# - Fix applied
# - Lesson learned
```

```markdown
### Learning Record
- **Bug**: [one-line description]
- **Root Cause**: [one-line explanation]
- **Fix**: [one-line description of fix]
- **Lesson**: [what to watch for in the future to prevent similar bugs]
- **Pattern**: [if this reveals a recurring pattern, note it for potential pattern scanner rule]
```

---

## ABORT CONDITIONS

| Condition | Action |
|-----------|--------|
| Cannot reproduce the error | Report reproduction failure, ask for more details |
| Root cause is in external dependency | Report finding, suggest dependency update or workaround |
| Fix requires architectural changes | Abort, suggest `/massu-create-plan` |
| All hypotheses rejected after 2 rounds | Report findings, escalate to user with all evidence gathered |

---

## COMPLETION REPORT

```markdown
## CS DEBUG COMPLETE

### Symptom
- **Error**: [original error]

### Investigation
- **Hypotheses tested**: [N]
- **Confirmed hypothesis**: H[N] — [description]

### Root Cause
- **What**: [bug description]
- **Why**: [why it happened]
- **Where**: [file:line]

### Fix Applied
| File | Change |
|------|--------|
| [file] | [change description] |

### Verification
| Check | Status |
|-------|--------|
| Target test | PASS |
| Full test suite | PASS ([N] tests) |
| Type check | PASS (0 errors) |
| Pattern scanner | PASS |

### Learning
- **Lesson**: [what was learned]
- **Prevention**: [how to prevent in future]
```
