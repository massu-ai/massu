---
name: massu-push-light
description: Fast pre-push verification (~90s) - patterns, types, tests, hooks
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Massu Push Light: Fast Pre-Push Verification

## Objective

Run fast verification checks (~90 seconds total) before pushing to catch the most common issues without the overhead of full builds or E2E tests.

---

## CHECKS TO RUN

Execute these checks in order. **STOP on first failure.**

### 1. Pattern Scanner (~5s)
```bash
bash scripts/massu-pattern-scanner.sh
```
**Catches:** Code pattern violations, import issues, config anti-patterns

### 2. TypeScript Check (~30s)
```bash
cd packages/core && npx tsc --noEmit
```
**Catches:** Type errors, missing imports, interface mismatches

### 3. Hook Compilation (~5s)
```bash
cd packages/core && npm run build:hooks
```
**Catches:** Hook compilation failures, invalid imports in hooks

### 4. Unit Tests (~30s)
```bash
npm test
```
**Catches:** Regressions, broken logic, handler errors

### 5. Build (~20s)
```bash
npm run build
```
**Catches:** Build failures, compilation errors

---

## EXECUTION

Run all checks and report results:

```bash
echo "=============================================="
echo "MASSU PUSH LIGHT - Fast Pre-Push Verification"
echo "=============================================="
echo ""

FAILED=0

echo "[1/5] Pattern Scanner..."
if bash scripts/massu-pattern-scanner.sh > /tmp/pattern-scanner.log 2>&1; then
  echo "  PASS"
else
  echo "  FAIL - see /tmp/pattern-scanner.log"
  FAILED=1
fi

echo "[2/5] TypeScript Check..."
if cd packages/core && npx tsc --noEmit 2>&1; then
  echo "  PASS"
else
  echo "  FAIL"
  FAILED=1
fi

echo "[3/5] Hook Compilation..."
if cd packages/core && npm run build:hooks > /dev/null 2>&1; then
  echo "  PASS"
else
  echo "  FAIL - Hook compilation error"
  FAILED=1
fi

echo "[4/5] Unit Tests..."
if npm test > /dev/null 2>&1; then
  echo "  PASS"
else
  echo "  FAIL - Tests failing"
  FAILED=1
fi

echo "[5/5] Build..."
if npm run build > /dev/null 2>&1; then
  echo "  PASS"
else
  echo "  FAIL - Build error"
  FAILED=1
fi

echo ""
echo "=============================================="
if [ $FAILED -eq 0 ]; then
  echo "ALL CHECKS PASSED - Safe to push"
  echo "=============================================="
else
  echo "CHECKS FAILED - Fix issues before pushing"
  echo "=============================================="
  exit 1
fi
```

---

## WHEN TO USE

- **Before every `git push`** - Catches ~90% of CI failures
- **After significant changes** - Quick sanity check
- **Before creating PR** - Ensure clean state

## WHEN TO USE FULL VERIFICATION INSTEAD

Use `/massu-push` (full) when:
- Making config schema changes
- Modifying tool registration patterns
- Changing core infrastructure
- Before major releases

---

## WHAT THIS DOESN'T CHECK

| Skipped Check | Why | Risk Level |
|---------------|-----|------------|
| Full integration tests | Can take 5+ minutes | Medium |
| Security scanner | Takes extra time | Low (run for security changes) |
| Coverage report | Takes extra time | Low |

---

## OUTPUT FORMAT

```
==============================================
MASSU PUSH LIGHT - Fast Pre-Push Verification
==============================================

[1/5] Pattern Scanner...    PASS
[2/5] TypeScript Check...   PASS
[3/5] Hook Compilation...   PASS
[4/5] Unit Tests...         PASS
[5/5] Build...              PASS

==============================================
ALL CHECKS PASSED - Safe to push
==============================================
```

---

## FAILURE RECOVERY

| Check Failed | How to Fix |
|--------------|------------|
| Pattern Scanner | Run `bash scripts/massu-pattern-scanner.sh` to see details |
| TypeScript | Run `cd packages/core && npx tsc --noEmit` for full error output |
| Hook Compilation | Run `cd packages/core && npm run build:hooks` for error details |
| Unit Tests | Run `npm test` to see failing tests |
| Build | Run `npm run build` for full error output |
