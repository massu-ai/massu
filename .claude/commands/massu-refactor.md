---
name: massu-refactor
description: Safe refactoring with behavioral equivalence, incremental transforms, and automatic rollback
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# CS Refactor: Safe Refactoring Workflow

## Objective

Restructure code safely, ensuring behavioral equivalence at every step. Changes are applied incrementally with verification after each batch. If behavioral equivalence cannot be maintained, the refactoring is aborted.

**Usage**: `/massu-refactor [description of the refactoring]`

## Workflow Position

```
/massu-create-plan -> /massu-plan -> /massu-refactor -> /massu-commit -> /massu-push
(PLAN)              (AUDIT PLAN)   (EXECUTE REFACTOR)  (COMMIT)        (PUSH)
```

---

## NON-NEGOTIABLE RULES

- **Behavioral equivalence is MANDATORY** — tests passing before MUST still pass after
- **Incremental batches only** — max 3 files per batch, verify after each
- **Never skip verification** — every batch gets type check + test run
- **Revert on regression** — if a batch breaks tests, revert it before continuing
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** — pre-existing issues found during refactoring MUST be fixed
- **Proof > reasoning. Commands > assumptions.**

---

## SCOPE GUARD (MANDATORY)

**This command is for MEDIUM refactorings. If ANY of these are true, ABORT:**

| Condition | Why It's Too Big | Alternative |
|-----------|-----------------|-------------|
| Refactoring touches > 20 files | Needs structured plan | `/massu-create-plan` |
| Changes database schema | Needs migration workflow | `/massu-migrate` |
| Changes public API contracts | Needs blast radius plan | `/massu-create-plan` |
| Renames MCP tool names | Affects all consumers | `/massu-create-plan` |
| Changes config interface fields | Affects all config users | `/massu-create-plan` |

```
SCOPE CHECK:
  1. Read the target code
  2. Grep for all references to exports/functions/types being changed
  3. Count affected files
  4. IF affected_files > 20:
       OUTPUT: "Refactoring scope is too large ([N] files). Use /massu-create-plan instead."
       ABORT
  5. IF changes database schema:
       OUTPUT: "Refactoring involves schema changes. Use /massu-migrate instead."
       ABORT
  6. IF changes public API contracts:
       OUTPUT: "Refactoring changes public API. Use /massu-create-plan for blast radius analysis."
       ABORT
```

---

## STEP 1: SCOPE ANALYSIS

### 1a. Read Target Code

Read every file that will be modified to understand current structure:

```bash
# Read the primary target file(s)
# Read all files that import from or reference the target
```

### 1b. Reference Analysis

For each export, function, type, or constant being changed:

```bash
# Find all references in the codebase
grep -rn "[export_name]" packages/core/src/ --include="*.ts"
grep -rn "[export_name]" packages/ --include="*.ts" --include="*.tsx"
grep -rn "[export_name]" .claude/commands/ --include="*.md"
grep -rn "[export_name]" scripts/ --include="*.sh"
```

### 1c. Impact Matrix

```markdown
### Impact Matrix

| File | References | Type | Action |
|------|-----------|------|--------|
| [file_1] | [function/type names] | CHANGE | [what changes] |
| [file_2] | [function/type names] | CHANGE | [what changes] |
| [file_3] | [function/type names] | KEEP | [why no change needed] |

**Total files affected: [N]**
**Scope check: [PASS if <= 20 / ABORT if > 20]**
```

---

## STEP 2: BASELINE SNAPSHOT

Capture the behavioral baseline BEFORE making any changes:

### 2a. Test Baseline

```bash
npm test 2>&1
```

Record:
```markdown
### Test Baseline
| Metric | Value |
|--------|-------|
| Total tests | [N] |
| Passing | [N] |
| Failing | [N] |
| Skipped | [N] |
```

### 2b. Type Check Baseline

```bash
cd packages/core && npx tsc --noEmit 2>&1
```

Record:
```markdown
### Type Check Baseline
| Metric | Value |
|--------|-------|
| Type errors | [N] |
```

**This baseline is the behavioral contract. After refactoring:**
- Test count MUST be >= baseline (can add tests, not lose them)
- Passing count MUST be >= baseline
- Type error count MUST be <= baseline (can fix errors, not add them)

---

## STEP 3: BLAST RADIUS ANALYSIS (CR-10)

**For EVERY export, function, type, or constant being renamed or moved:**

```bash
# Grep entire codebase for the old name
grep -rn "[old_name]" packages/ website/ scripts/ .claude/ --include="*.ts" --include="*.tsx" --include="*.md" --include="*.sh" --include="*.yaml"
```

### Categorize Every Occurrence

```markdown
### Blast Radius — [old_name] → [new_name]

| File:Line | Occurrence | Category | Reason |
|-----------|-----------|----------|--------|
| [file:NN] | [context] | CHANGE | Will be updated |
| [file:NN] | [context] | KEEP | [reason — e.g., string literal, comment, different variable] |
```

**Requirements:**
- Zero INVESTIGATE items — every occurrence must be categorized as CHANGE or KEEP
- Every CHANGE item must be tracked in the transformation plan
- If any occurrence cannot be categorized, STOP and investigate before proceeding

---

## STEP 4: INCREMENTAL TRANSFORMATION

Apply changes in small batches. **Maximum 3 files per batch.**

```
TRANSFORMATION LOOP:
  batch_number = 1
  WHILE files_remaining > 0:
    1. Select next batch (max 3 files)
    2. Apply changes to batch
    3. Run type check:
         cd packages/core && npx tsc --noEmit 2>&1
    4. Run tests:
         npm test 2>&1
    5. Compare against baseline:
         - Type errors must be <= baseline
         - Passing tests must be >= baseline
    6. IF check degrades from baseline:
         - REVERT the batch: git checkout -- [batch files]
         - Investigate why the batch caused regression
         - Fix the approach and retry (max 3 retries per batch)
    7. IF check maintains or improves baseline:
         - Record batch as successful
         - Proceed to next batch
    batch_number++
```

### Batch Record

```markdown
### Batch [N]: [description]

| File | Change |
|------|--------|
| [file_1] | [what was changed] |
| [file_2] | [what was changed] |

| Check | Before | After | Status |
|-------|--------|-------|--------|
| Type errors | [N] | [N] | EQUIVALENT/IMPROVED |
| Tests passing | [N] | [N] | EQUIVALENT/IMPROVED |
```

---

## STEP 5: NEGATIVE VERIFICATION

**For every renamed or removed export, function, type, or constant:**

```bash
# Verify old name no longer exists in source
grep -rn "[old_name]" packages/core/src/ --include="*.ts"
# MUST return 0 matches
```

**For moved files:**

```bash
# Verify old file no longer exists
ls [old_file_path]
# MUST fail (file should not exist)
```

```markdown
### Negative Verification

| Old Name/Path | Grep Result | Status |
|--------------|-------------|--------|
| [old_name] | 0 matches | CLEAN |
| [old_path] | File not found | CLEAN |
```

**If ANY old reference remains:** Fix it before proceeding.

---

## STEP 6: FINAL VERIFICATION

Run the full gate sequence:

### Gate 1: Pattern Scanner (VR-PATTERN)
```bash
bash scripts/massu-pattern-scanner.sh
# MUST exit 0
```

### Gate 2: Type Check (VR-TYPE)
```bash
cd packages/core && npx tsc --noEmit
# MUST show 0 errors (or <= baseline)
```

### Gate 3: All Tests (VR-TEST)
```bash
npm test
# MUST exit 0, all tests pass
```

### Gate 4: Hook Build (VR-HOOK-BUILD)
```bash
cd packages/core && npm run build:hooks
# MUST exit 0
```

### Compare Against Baseline

```markdown
### Baseline Comparison

| Metric | Before | After | Delta | Status |
|--------|--------|-------|-------|--------|
| Tests passing | [N] | [N] | [+/-N] | EQUIVALENT/IMPROVED |
| Tests total | [N] | [N] | [+/-N] | EQUIVALENT/IMPROVED |
| Type errors | [N] | [N] | [+/-N] | EQUIVALENT/IMPROVED |
| Pattern violations | [N] | [N] | [+/-N] | EQUIVALENT/IMPROVED |
```

---

## STEP 7: BEHAVIORAL EQUIVALENCE PROOF

Generate the formal proof table:

```markdown
### Behavioral Equivalence Proof

| Metric | Before | After | Delta | Status |
|--------|--------|-------|-------|--------|
| Tests passing | [N] | [N] | 0 | EQUIVALENT |
| Tests total | [N] | [N] | 0 | EQUIVALENT |
| Type errors | [N] | [N] | 0 | EQUIVALENT |
| Pattern violations | 0 | 0 | 0 | EQUIVALENT |
| Hook build | Exit 0 | Exit 0 | - | EQUIVALENT |

**BEHAVIORAL EQUIVALENCE: PROVEN / NOT PROVEN**
```

**If NOT PROVEN:** Document the delta and determine if it's acceptable (e.g., test count increased because new tests were added — this is an IMPROVEMENT, not a regression).

---

## ABORT PROTOCOL

**If at any point the refactoring causes test regressions that cannot be resolved within 3 attempts per batch:**

```bash
# Revert ALL uncommitted changes
git checkout -- .
```

```markdown
### REFACTORING ABORTED

- **Reason**: [why the refactoring failed]
- **Batch that failed**: [batch N]
- **Error**: [what went wrong]
- **Files reverted**: ALL uncommitted changes
- **Recommendation**: [suggest /massu-create-plan with specific details about what needs careful planning]
```

---

## COMPLETION REPORT

```markdown
## CS REFACTOR COMPLETE

### Scope
- **Description**: [what was refactored]
- **Files changed**: [N]
- **Batches**: [N]

### Blast Radius
| Category | Count |
|----------|-------|
| Files changed | [N] |
| References updated | [N] |
| References kept (with reason) | [N] |

### Behavioral Equivalence Proof
| Metric | Before | After | Delta | Status |
|--------|--------|-------|-------|--------|
| Tests passing | [N] | [N] | [0] | EQUIVALENT |
| Type errors | [N] | [N] | [0] | EQUIVALENT |

### Verification Gates
| Gate | Status |
|------|--------|
| Pattern Scanner | PASS |
| Type Safety | PASS |
| Tests | PASS ([N] passed) |
| Hook Build | PASS |
| Negative Verification | PASS (0 stale references) |

### Changes Summary
| File | Change |
|------|--------|
| [file] | [description] |

### Next Steps
- Review changes: `git diff`
- Commit: `/massu-commit`
```
