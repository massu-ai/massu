---
name: massu-push-light
description: Fast pre-push verification (~90s) - patterns, security, types, hooks, tests, build
allowed-tools: Bash(*)
disable-model-invocation: true
---
name: massu-push-light

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
**Catches:** Code pattern violations, ESM import issues, config anti-patterns, hardcoded prefixes

### 2. Generalization Scanner (~5s)
```bash
bash scripts/massu-generalization-scanner.sh
```
**Catches:** Hardcoded project names, /Users/ paths, Supabase IDs, API endpoints

### 3. Security Scanner (~5s)
```bash
bash scripts/massu-security-scanner.sh
```
**Catches:** Hardcoded secrets, unsafe patterns, @ts-ignore usage

### 4. TypeScript Check (~30s)
```bash
cd packages/core && npx tsc --noEmit
```
**Catches:** Type errors, missing imports, interface mismatches

### 5. Hook Compilation (~5s)
```bash
cd packages/core && npm run build:hooks
```
**Catches:** Hook compilation failures, invalid imports in hooks

### 6. Unit Tests (~30s)
```bash
npm test
```
**Catches:** Regressions, broken logic, handler errors

### 7. Build (~20s)
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

echo "[1/7] Pattern Scanner..."
if bash scripts/massu-pattern-scanner.sh > /tmp/pattern-scanner.log 2>&1; then
  echo "  PASS"
else
  echo "  FAIL - see /tmp/pattern-scanner.log"
  FAILED=1
fi

echo "[2/7] Generalization Scanner..."
if bash scripts/massu-generalization-scanner.sh > /tmp/gen-scanner.log 2>&1; then
  echo "  PASS"
else
  echo "  FAIL - see /tmp/gen-scanner.log"
  FAILED=1
fi

echo "[3/7] Security Scanner..."
if bash scripts/massu-security-scanner.sh > /tmp/security-scanner.log 2>&1; then
  echo "  PASS"
else
  echo "  FAIL - see /tmp/security-scanner.log"
  FAILED=1
fi

echo "[4/7] TypeScript Check..."
if cd packages/core && npx tsc --noEmit 2>&1; then
  echo "  PASS"
else
  echo "  FAIL"
  FAILED=1
fi

echo "[5/7] Hook Compilation..."
if cd packages/core && npm run build:hooks > /dev/null 2>&1; then
  echo "  PASS"
else
  echo "  FAIL - Hook compilation error"
  FAILED=1
fi

echo "[6/7] Unit Tests..."
if npm test > /dev/null 2>&1; then
  echo "  PASS"
else
  echo "  FAIL - Tests failing"
  FAILED=1
fi

echo "[7/7] Build..."
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
| Coverage report | Takes extra time | Low |
| Migration validation | Takes extra time | Low (run for migration changes) |

---

## OUTPUT FORMAT

```
==============================================
MASSU PUSH LIGHT - Fast Pre-Push Verification
==============================================

[1/7] Pattern Scanner...         PASS
[2/7] Generalization Scanner...  PASS
[3/7] Security Scanner...        PASS
[4/7] TypeScript Check...        PASS
[5/7] Hook Compilation...        PASS
[6/7] Unit Tests...              PASS
[7/7] Build...                   PASS

==============================================
ALL CHECKS PASSED - Safe to push
==============================================
```

---

## FAILURE RECOVERY

| Check Failed | How to Fix |
|--------------|------------|
| Pattern Scanner | Run `bash scripts/massu-pattern-scanner.sh` to see details |
| Generalization Scanner | Run `bash scripts/massu-generalization-scanner.sh` for details |
| Security Scanner | Run `bash scripts/massu-security-scanner.sh` for details |
| TypeScript | Run `cd packages/core && npx tsc --noEmit` for full error output |
| Hook Compilation | Run `cd packages/core && npm run build:hooks` for error details |
| Unit Tests | Run `npm test` to see failing tests |
| Build | Run `npm run build` for full error output |
