---
name: massu-codebase-audit
description: Run comprehensive multi-phase codebase audit (patterns, security, types, tests, performance)
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Massu Codebase Audit: Comprehensive Periodic Audit Protocol

## Objective

Run a full-scope audit of the entire codebase covering **multiple critical areas**. Designed for periodic execution (weekly/monthly) to catch issues before they reach production.

**Recommended cadence**: Run monthly to catch drift before it accumulates. Set a calendar reminder.

---

## AUDIT SCOPE

| Phase | Category | Command / Script | Priority |
|-------|----------|-----------------|----------|
| 1 | Pattern Compliance | `bash scripts/massu-pattern-scanner.sh` | CRITICAL |
| 2 | Security Audit | `bash scripts/massu-security-scanner.sh` | CRITICAL |
| 3 | Type Safety | `cd packages/core && npx tsc --noEmit` | CRITICAL |
| 4 | Test Suite | `npm test` | CRITICAL |
| 5 | Hook Compilation | `cd packages/core && npm run build:hooks` | HIGH |
| 6 | Build Verification | `npm run build` | HIGH |
| 7 | Import Chain Safety | Check for circular/heavy imports | HIGH |
| 8 | Tool Registration | Verify all tools wired in tools.ts (CR-11) | HIGH |
| 9 | Config Validation | Parse and validate massu.config.yaml | MEDIUM |
| 10 | Dead Code Detection | Unused exports, orphaned files | MEDIUM |
| 11 | Test Coverage | `bash scripts/massu-test-coverage.sh` | MEDIUM |
| 12 | Error Handling | Try-catch coverage, error propagation | MEDIUM |
| 13 | Performance Analysis | N+1 patterns, unbounded queries | LOW |
| 14 | Business Logic Audit | Grep for plan-gating patterns, tier enforcement, auth completeness | HIGH |
| 15 | Security Logic Audit | Run enhanced security scanner + manual SSRF/auth/encryption review | HIGH |
| 16 | Marketing Accuracy | Compare feature counts in config vs website display | MEDIUM |
| 17 | Tooling Self-Check | `bash scripts/massu-verify-tooling.sh` | MEDIUM |

---

## QUICK START

Run the critical checks:
```bash
bash scripts/massu-pattern-scanner.sh && \
bash scripts/massu-security-scanner.sh && \
cd packages/core && npx tsc --noEmit && \
npm test
```

---

## NON-NEGOTIABLE RULES

- **Proof > Claims** - Show script output, not summaries
- **ALL phases** - Do not skip any phase
- **Zero tolerance** - Any CRITICAL or HIGH violation blocks "audit complete"
- **No assumptions** - Run scripts, don't guess
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - If ANY issue is discovered during codebase audit - whether from current changes OR pre-existing - fix it immediately. "Not in scope" and "pre-existing" are NEVER valid reasons to skip a fix. When fixing a bug, search entire codebase for same pattern and fix ALL instances.

---

## PHASE 1: PATTERN COMPLIANCE (CRITICAL)

**Command**: `bash scripts/massu-pattern-scanner.sh`

**What It Checks**:
- ESM import patterns (`.ts` extensions)
- Config access patterns (getConfig() usage)
- Tool registration completeness
- Hook compilation readiness
- Hardcoded project-specific values (should use config)

**Expected**: Exit 0 (all checks pass)

---

## PHASE 2: SECURITY AUDIT (CRITICAL)

**Command**: `bash scripts/massu-security-scanner.sh`

**What It Checks**:
1. Hardcoded secrets/API keys
2. Exposed credentials in source
3. @ts-nocheck / @ts-ignore usage
4. Input validation coverage
5. Sensitive data in logs
6. Unsafe eval/exec patterns
7. Prototype pollution vulnerabilities

---

## PHASE 3: TYPE SAFETY (CRITICAL)

```bash
cd packages/core && npx tsc --noEmit
```

**Expected**: 0 errors, 0 warnings

---

## PHASE 4: TEST SUITE (CRITICAL)

```bash
npm test
```

**What It Checks**:
1. All vitest tests pass
2. No skipped tests without valid reason
3. Critical path coverage

---

## PHASE 5: HOOK COMPILATION (HIGH)

```bash
cd packages/core && npm run build:hooks
```

**Expected**: Exit 0 (all hooks compile)

---

## PHASE 6: BUILD VERIFICATION (HIGH)

```bash
npm run build
```

**Expected**: Exit 0

---

## PHASE 7: IMPORT CHAIN SAFETY (HIGH)

```bash
# Check for circular dependencies
npx madge --circular packages/core/src/
# Expected: 0 circular dependencies

# Check for heavy imports in hooks
grep -rn "import.*from 'better-sqlite3'" packages/core/src/hooks/
# Expected: 0 matches (hooks must be lightweight)
```

---

## PHASE 8: TOOL REGISTRATION (HIGH)

```bash
# Verify all tool modules are wired into tools.ts (CR-11)
# For each module in packages/core/src/ that exports getXToolDefinitions:
grep -rn "getToolDefinitions\|ToolDefinitions" packages/core/src/*.ts | grep -v __tests__
# Compare against tools.ts imports
grep -n "import.*from" packages/core/src/tools.ts
```

---

## PHASE 9: CONFIG VALIDATION (MEDIUM)

```bash
# Verify massu.config.yaml parses without errors
node -e "const yaml = require('yaml'); const fs = require('fs'); yaml.parse(fs.readFileSync('massu.config.yaml', 'utf-8')); console.log('Config valid');"
```

---

## PHASE 10: DEAD CODE DETECTION (MEDIUM)

```bash
# Find exported functions not imported anywhere
grep -rn "export function\|export const\|export class" packages/core/src/ | grep -v __tests__ | head -20
# Cross-reference with imports
```

---

## PHASE 11: TEST COVERAGE (MEDIUM)

```bash
bash scripts/massu-test-coverage.sh
```

---

## PHASE 12: ERROR HANDLING (MEDIUM)

```bash
# Find async functions without try-catch
grep -rn "async function\|async (" packages/core/src/ | grep -v __tests__ | head -20
# Check for error propagation patterns
grep -rn "catch.*throw\|catch.*console" packages/core/src/ | head -10
```

---

## PHASE 13: PERFORMANCE ANALYSIS (LOW)

```bash
# Find unbounded queries or loops
grep -rn "findMany\|SELECT \*" packages/core/src/ | grep -v __tests__ | head -10
# Check for inefficient patterns
```

---

## PHASE 14: BUSINESS LOGIC AUDIT (HIGH)

Check that tier-restricted features are properly gated:
1. Grep website dashboard pages for `requirePlan()` calls
2. Verify every paid route has server-side plan enforcement
3. Check pricing constants in code match `massu.config.yaml`
4. Verify no `TODO` or stub implementations in auth flows

```bash
# Plan gating coverage
grep -rn 'requirePlan' /Users/eko3/massu-internal/website/src/app/ --include="*.ts" --include="*.tsx" | wc -l
# Auth stubs
grep -rn 'TODO\|FIXME\|stub' /Users/eko3/massu-internal/website/src/ --include="*.ts" | grep -i auth | head -20
```

---

## PHASE 15: SECURITY LOGIC AUDIT (HIGH)

Run the enhanced security scanner and review output:
```bash
bash scripts/massu-security-scanner.sh
```

Manually review:
1. SSRF protection on webhook URL inputs
2. Auth callback completeness (no pass-through)
3. Encryption error handling (no silent fallback)

---

## PHASE 16: MARKETING ACCURACY (MEDIUM)

Compare `massu.config.yaml` tool counts/tiers against website features page data:
1. Count tools in config, compare to website display count
2. Verify tier badges match config tiers
3. Check pricing values match config

---

## PHASE 17: TOOLING SELF-CHECK (MEDIUM)

```bash
bash scripts/massu-verify-tooling.sh
```

Verifies all verification tools are functional (scripts exist, commands have frontmatter, no broken references).

---

## AUDIT REPORT FORMAT

```markdown
# MASSU CODEBASE AUDIT REPORT

**Date**: [YYYY-MM-DD]
**Auditor**: [Name/Agent]
**Scope**: Full Multi-Phase Audit
**Duration**: [X minutes]

## Executive Summary
- **Overall Health**: PASS / NEEDS ATTENTION / CRITICAL
- **Phases Passed**: X/17
- **Critical Issues**: X
- **Warnings**: X

## Phase Results

| Phase | Check | Status | Issues |
|-------|-------|--------|--------|
| 1 | Pattern Compliance | PASS/FAIL | |
| 2 | Security | PASS/FAIL | |
| ... | ... | ... | |

## Critical Issues (Must Fix)
| # | Phase | Issue | Location | Fix |
|---|-------|-------|----------|-----|

## High Priority Issues
| # | Phase | Issue | Location | Fix |
|---|-------|-------|----------|-----|

## Recommendations
| # | Phase | Suggestion | Impact |
|---|-------|------------|--------|

## Verification Proof
[Include command outputs for critical checks]

## Next Actions
1. [Action item 1]
2. [Action item 2]
```

---

## EXECUTION CHECKLIST

### Critical Priority (Must Pass)
- [ ] Phase 1: Pattern Scanner - `bash scripts/massu-pattern-scanner.sh`
- [ ] Phase 2: Security Scanner - `bash scripts/massu-security-scanner.sh`
- [ ] Phase 3: Type Safety - `cd packages/core && npx tsc --noEmit`
- [ ] Phase 4: Test Suite - `npm test`

### High Priority (Should Pass)
- [ ] Phase 5: Hook Compilation - `cd packages/core && npm run build:hooks`
- [ ] Phase 6: Build Verification - `npm run build`
- [ ] Phase 7: Import Chain Safety
- [ ] Phase 8: Tool Registration (CR-11)
- [ ] Phase 14: Business Logic Audit
- [ ] Phase 15: Security Logic Audit

### Medium Priority (Review)
- [ ] Phase 9: Config Validation
- [ ] Phase 10: Dead Code Detection
- [ ] Phase 11: Test Coverage
- [ ] Phase 12: Error Handling
- [ ] Phase 16: Marketing Accuracy
- [ ] Phase 17: Tooling Self-Check

### Low Priority (Informational)
- [ ] Phase 13: Performance Analysis

---

## RECOMMENDED FREQUENCY

| Check Type | Frequency | Trigger |
|------------|-----------|---------|
| Full Audit | Monthly | Scheduled |
| Critical Only (1-4) | Weekly | After major changes |
| Pattern Scanner (1) | Every commit | Pre-commit hook |
| Security (2) | Before releases | Pre-deployment |
| Type Safety (3) | Every push | Git hook |

---

## POST-AUDIT ACTIONS

1. **If Critical Failed**: Stop deployment, fix immediately
2. **If High Failed**: Fix before next release
3. **If Patterns Violated**: Fix before commit
4. **Update CLAUDE.md**: Add new learnings
5. **Update This Audit**: Add new checks based on findings

---

## Related Audit Commands

| Command | Focus | When to Use Instead |
|---------|-------|---------------------|
| /massu-codebase-audit | Full multi-phase audit | Comprehensive review |
| /massu-security-scan | Security deep-dive | Security-focused work |
| /massu-learning-audit | Auto-learning effectiveness | Post-incident |
| /massu-import-audit | Import chains, build safety | Build issues |
| /massu-config-audit | Config-code alignment | Config bugs |
| /massu-type-audit | Type mismatch detection | Type errors |
| /massu-api-contract | API contract verification | API changes |

---

**Document Version**: 1.0
**Created**: February 2026
**Based On**: Generalized from enterprise audit methodology
