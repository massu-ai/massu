---
name: massu-cleanup
description: Dead code removal — unused imports, orphaned files, dead exports, and stale references
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-cleanup

# CS Cleanup: Dead Code Removal

## Objective

Identify and remove dead code across the codebase: unused imports, orphaned files, dead exports, and stale references. Changes are applied by category with verification after each batch. If any removal causes test regressions, the batch is reverted and investigated.

**Usage**: `/massu-cleanup` (full scan) or `/massu-cleanup [area]` (focused: imports, exports, files, deps)

---

## NON-NEGOTIABLE RULES

- **Never delete without verifying zero references** — grep before every removal
- **Run tests after each category** — a passing baseline MUST be maintained
- **Revert on regression** — if a batch breaks tests, revert before continuing
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** — pre-existing issues found during cleanup MUST be fixed
- **No config or public API removals** — scope only to internal dead code
- **Proof > reasoning. Commands > assumptions.**

---

## SCOPE GUARD (MANDATORY)

**This command is for INTERNAL dead code only. If ANY of these are true, ABORT:**

| Condition | Why It's Too Big | Alternative |
|-----------|-----------------|-------------|
| Removal touches exported public API | Needs blast radius plan | `/massu-create-plan` |
| Removes MCP tool name | Affects all consumers | `/massu-create-plan` |
| Removes config interface fields | Affects all config users | `/massu-create-plan` |
| Touches > 20 files | Needs structured plan | `/massu-create-plan` |

---

## STEP 1: BASELINE SNAPSHOT

Capture the behavioral baseline BEFORE making any changes:

### 1a. Test Baseline

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
```

### 1b. Type Check Baseline

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

**This baseline is the behavioral contract. After cleanup:**
- Test count MUST be >= baseline
- Passing count MUST be >= baseline
- Type error count MUST be <= baseline

---

## STEP 2: DISCOVERY

Scan all categories in parallel. Do NOT remove anything yet.

### 2a. Unused Imports

```bash
# TypeScript unused imports (ts error 6133)
cd packages/core && npx tsc --noEmit 2>&1 | grep "is declared but"

# ESLint-style: imports never referenced in file body
grep -rn "^import" packages/core/src/ --include="*.ts" | head -50
```

### 2b. Dead Exports

```bash
# Exported symbols with zero external references
grep -rn "^export " packages/core/src/ --include="*.ts" | grep -v "__tests__" | while IFS=: read file line content; do
  name=$(echo "$content" | grep -oP '(?<=export (function|const|class|type|interface|enum) )\w+' | head -1)
  if [ -n "$name" ]; then
    count=$(grep -rn "$name" packages/core/src/ --include="*.ts" | grep -v "^$file:" | grep -v "__tests__" | wc -l)
    if [ "$count" -eq 0 ]; then
      echo "DEAD EXPORT: $name in $file"
    fi
  fi
done
```

### 2c. Orphaned Files

```bash
# Source files not imported anywhere
for f in packages/core/src/*.ts; do
  base=$(basename "$f" .ts)
  # Skip entry points and test files
  if [[ "$base" == "server" || "$base" == "index" || "$f" == *"__tests__"* ]]; then
    continue
  fi
  count=$(grep -rn "from.*['\"]\./${base}" packages/core/src/ --include="*.ts" | grep -v "__tests__" | wc -l)
  if [ "$count" -eq 0 ]; then
    echo "POSSIBLY ORPHANED: $f"
  fi
done
```

### 2d. Unused Dependencies

```bash
# List all dependencies
cat packages/core/package.json | grep -A 50 '"dependencies"'

# Check each dependency usage
grep -rn "from.*'better-sqlite3'\|require.*better-sqlite3" packages/core/src/ --include="*.ts" | wc -l
grep -rn "from.*'yaml'\|require.*yaml" packages/core/src/ --include="*.ts" | wc -l
```

### 2e. TODO/FIXME/HACK Comments

```bash
# Enumerate all stale markers — informational only (no auto-removal)
grep -rn "TODO\|FIXME\|HACK\|XXX\|DEPRECATED" packages/core/src/ --include="*.ts" | grep -v "__tests__"
```

---

## STEP 3: CLASSIFICATION

For every candidate found in Step 2, classify each as:

```markdown
### Cleanup Inventory

| Category | Item | File | References | Action | Reason |
|----------|------|------|-----------|--------|--------|
| Unused import | [name] | [file] | 0 | REMOVE | Never used after import |
| Dead export | [name] | [file] | 0 | INVESTIGATE → REMOVE/KEEP | [context] |
| Orphaned file | [file] | - | 0 | INVESTIGATE → REMOVE/KEEP | [context] |
| Stale dep | [pkg] | package.json | [N] | REMOVE/KEEP | [reason] |
```

**Rules:**
- Zero INVESTIGATE items allowed before implementation starts
- Every REMOVE item must be verified with negative grep
- Every KEEP item must have a documented reason

---

## STEP 4: CLEANUP

Apply removals by category. Maximum 1 category per batch.

```
CLEANUP LOOP:
  FOR EACH category in [imports, exports, files, deps]:
    1. Select all REMOVE items in this category
    2. Apply removals
    3. Run type check:
         cd packages/core && npx tsc --noEmit 2>&1
    4. Run tests:
         npm test 2>&1
    5. Compare against baseline:
         - Type errors must be <= baseline
         - Passing tests must be >= baseline
    6. IF regression detected:
         - REVERT the entire category batch
         - Document failure reason
         - Skip this category
    7. IF clean:
         - Record category as successful
         - Proceed to next category
```

### Category Record Template

```markdown
### Category: [imports/exports/files/deps]

| Item | File | Action | Verification |
|------|------|--------|-------------|
| [item] | [file] | REMOVED | grep returned 0 |

| Check | Before | After | Status |
|-------|--------|-------|--------|
| Type errors | [N] | [N] | EQUIVALENT/IMPROVED |
| Tests passing | [N] | [N] | EQUIVALENT/IMPROVED |
```

---

## STEP 5: NEGATIVE VERIFICATION (VR-NEGATIVE)

For every removed item, confirm it is gone:

```bash
# Unused import removed
grep -rn "[import_name]" packages/core/src/ --include="*.ts"
# MUST return 0 matches (or only in unrelated contexts)

# Dead export removed
grep -rn "export.*[export_name]" packages/core/src/ --include="*.ts"
# MUST return 0 matches

# Orphaned file removed
ls [removed_file_path]
# MUST fail (file should not exist)
```

```markdown
### Negative Verification

| Item | Grep Result | Status |
|------|-------------|--------|
| [name] | 0 matches | CLEAN |
| [file] | File not found | CLEAN |
```

**If ANY stale reference remains:** Fix it before proceeding.

---

## STEP 6: FINAL VERIFICATION

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

---

## COMPLETION REPORT

```markdown
## CS CLEANUP COMPLETE

### Scope
- **Files modified**: [N]
- **Files deleted**: [N]
- **Categories processed**: [N]

### Items Removed
| Category | Count | Examples |
|----------|-------|---------|
| Unused imports | [N] | [examples] |
| Dead exports | [N] | [examples] |
| Orphaned files | [N] | [names] |
| Unused dependencies | [N] | [names] |

### Items Kept (with reason)
| Item | Reason |
|------|--------|
| [item] | [reason — e.g., used in tests, reserved for upcoming feature] |

### Behavioral Equivalence
| Metric | Before | After | Delta | Status |
|--------|--------|-------|-------|--------|
| Tests passing | [N] | [N] | [0] | EQUIVALENT |
| Type errors | [N] | [N] | [0] | EQUIVALENT/IMPROVED |

### Verification Gates
| Gate | Status |
|------|--------|
| Pattern Scanner | PASS |
| Type Safety | PASS |
| Tests | PASS ([N] passed) |
| Hook Build | PASS |
| Negative Verification | PASS (0 stale references) |

### Next Steps
- Review changes: `git diff`
- Commit: `/massu-commit`
```
