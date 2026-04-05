# Phase 5: Push Verification & Push

> Reference doc for `/massu-golden-path`. Return to main file for overview.

```
[GOLDEN PATH -- PHASE 5: PUSH VERIFICATION]
```

## 5.1 Pre-Flight

```bash
git log origin/main..HEAD --oneline  # Commits to push
```

## 5.2 Tier 1: Quick Re-Verification

Run in parallel where possible:

| Check | Command |
|-------|---------|
| Pattern Scanner | `bash scripts/massu-pattern-scanner.sh` |
| Generalization | `bash scripts/massu-generalization-scanner.sh` |
| TypeScript | `cd packages/core && npx tsc --noEmit` |
| Build | `npm run build` |
| Hook Compilation | `cd packages/core && npm run build:hooks` |

## 5.3 Tier 2: Test Suite (CRITICAL)

### 5.3.0 Regression Detection (MANDATORY FIRST)

```bash
# Establish baseline on main
git stash && git checkout main -q
npm test 2>&1 | tee /tmp/baseline-tests.txt
git checkout - -q && git stash pop -q

# Run on current branch
npm test 2>&1 | tee /tmp/current-tests.txt

# Compare: any test passing on main but failing now = REGRESSION
# Regressions MUST be fixed before push
```

### 5.3.1-5.3.3 Test Execution

Use **parallel Task agents** for independent checks:

```
Agent Group A (parallel):
- Agent 1: npm test (unit tests)
- Agent 2: npm audit --audit-level=high
- Agent 3: bash scripts/massu-security-scanner.sh

Sequential:
- VR-TOOL-REG: verify ALL new tools registered in tools.ts
- VR-GENERIC: verify ALL files pass generalization scanner
```

## 5.4 Tier 3: Security & Compliance

| Check | Command |
|-------|---------|
| npm audit | `npm audit --audit-level=high` |
| Security scan | `bash scripts/massu-security-scanner.sh` |
| Config validation | Parse massu.config.yaml without errors |

## 5.5 Tier 4: Final Gate

All tiers must pass:

| Tier | Status |
|------|--------|
| Tier 1: Quick Checks | PASS/FAIL |
| Tier 2: Test Suite + Regression | PASS/FAIL |
| Tier 3: Security & Compliance | PASS/FAIL |

---

## Phase 5 Gate -> APPROVAL POINT #4: PUSH

See `approval-points.md` for the exact format.

After approval: `git push origin [branch]`, then verify with `gh run list --limit 3`.
