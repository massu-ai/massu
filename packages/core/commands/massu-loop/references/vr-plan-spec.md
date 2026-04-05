# VR-PLAN Verification Details

> Reference doc for `/massu-loop`. Return to main file for overview.

## VR-PLAN: VERIFICATION PLANNING STEP

**Before executing ANY verification checks, ENUMERATE all applicable VR-* checks first.**

```markdown
### VR-PLAN: Verification Strategy

**Work being verified**: [description]
**Domains touched**: [tools / hooks / config / tests / website]

| # | VR-* Check | Target File/Component | Why Applicable | Status |
|---|------------|----------------------|----------------|--------|
| 1 | VR-BUILD | Full project | Always required | PENDING |
| 2 | VR-TYPE | packages/core | Always required | PENDING |
| 3 | VR-TEST | All tests | Always required | PENDING |
| ... | ... | ... | ... | ... |

**Execution order**: VR-FILE first -> VR-BUILD/VR-TYPE -> VR-TEST -> VR-TOOL-REG -> VR-HOOK-BUILD -> VR-PATTERN
```

### Mandatory Checks (ALWAYS include)

| Check | When to Include |
|-------|----------------|
| VR-BUILD | ALWAYS |
| VR-TYPE | ALWAYS |
| VR-TEST | ALWAYS |
| VR-FILE | When files created |
| VR-GREP | When code added |
| VR-NEGATIVE | When code removed |
| VR-TOOL-REG | When new tools added (3-function pattern in tools.ts) |
| VR-HOOK-BUILD | When hooks added or modified |
| VR-CONFIG | When config.ts or massu.config.yaml changed |
| VR-PATTERN | Always (pattern scanner) |
| VR-PLAN-COVERAGE | When implementing a plan |
| VR-COUNT | When verifying numeric expectations |

Do NOT start verification until VR-PLAN is complete with all domains, checks, targets, and execution order.

---

## COMPLETION CRITERIA

CS Loop is COMPLETE **only when BOTH gates pass: Code Quality AND Plan Coverage**.

### GATE 1: Code Quality Verification (All Must Pass in SAME Audit Run)
- [ ] All phases executed, all checkpoints passed with zero gaps
- [ ] Pattern scanner: Exit 0
- [ ] Type check: 0 errors
- [ ] Build: Exit 0
- [ ] Tests: ALL PASS (MANDATORY)
- [ ] Hook build: Exit 0
- [ ] Security: No secrets staged

### GATE 2: Plan Coverage Verification
- [ ] Plan file read (actual file, not memory)
- [ ] ALL items extracted into tracking table
- [ ] EACH item verified with VR-* proof
- [ ] Coverage = 100% (99% = FAIL)
- [ ] Plan document updated with completion status

### DUAL VERIFICATION REQUIREMENT

**BOTH gates must pass:**

```markdown
## DUAL VERIFICATION RESULT
| Gate | Status | Details |
|------|--------|---------|
| Code Quality | PASS/FAIL | Pattern scanner, build, types, tests |
| Plan Coverage | PASS/FAIL | X/Y items (Z%) |

**RESULT: COMPLETE** (only if both PASS)
```

**Code Quality: PASS + Plan Coverage: FAIL = NOT COMPLETE**

### Additional Verification
- [ ] Tool Registration: ALL new tools wired in tools.ts (3-function pattern)
- [ ] Hook Build: esbuild compilation succeeds
- [ ] Session state shows COMPLETED
- [ ] Phase archives created
- [ ] Plan document completion table added at TOP

---

## COMPLETION OUTPUT

```markdown
## [CS LOOP - COMPLETE]

### Dual Verification Certification
- **Audit loops required**: N (loop #N achieved 0 gaps + 100% coverage)
- **Code Quality Gate**: PASS
- **Plan Coverage Gate**: PASS (X/X items = 100%)
- **CERTIFIED**: Both gates passed in single complete audit

### Summary
- Total iterations: N
- Total checkpoints: N (all PASSED)
- Final audit loop: #N - ZERO GAPS + 100% COVERAGE

### GATE 1: Code Quality Evidence
| Gate | Command | Result |
|------|---------|--------|
| Pattern scanner | `bash scripts/massu-pattern-scanner.sh` | Exit 0 |
| Type check | `cd packages/core && npx tsc --noEmit` | 0 errors |
| Build | `npm run build` | Exit 0 |
| Tests | `npm test` | All pass |
| Hook build | `cd packages/core && npm run build:hooks` | Exit 0 |

### GATE 2: Plan Coverage Evidence
| Item # | Description | Verification | Status |
|--------|-------------|--------------|--------|
| P1-001 | [description] | [VR-* output] | COMPLETE |
| ... | ... | ... | COMPLETE |

**Plan Coverage: X/X items (100%)**

### Plan Document Updated
- File: [path]
- Completion table: ADDED at TOP
- Plan Status: COMPLETE

### Session State
Updated: session-state/CURRENT.md
Status: COMPLETED
```
