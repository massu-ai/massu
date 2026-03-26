# VR-PLAN Verification Details

> Reference doc for `/massu-loop`. Return to main file for overview.

## VR-PLAN: VERIFICATION PLANNING STEP

**Before executing ANY verification checks, ENUMERATE all applicable VR-* checks first.**

```markdown
### VR-PLAN: Verification Strategy

**Work being verified**: [description]
**Domains touched**: [database / UI / API / auth / build / config]

| # | VR-* Check | Target File/Component | Why Applicable | Status |
|---|------------|----------------------|----------------|--------|
| 1 | VR-BUILD | Full project | Always required | PENDING |
| 2 | VR-TYPE | Full project | Always required | PENDING |
| 3 | VR-TEST | Full project | Always required (CR-21) | PENDING |
| ... | ... | ... | ... | ... |

**Execution order**: VR-SCHEMA first -> VR-BUILD/VR-TYPE -> VR-TEST -> VR-RENDER/VR-COUPLING -> VR-RUNTIME
```

### Mandatory Checks (ALWAYS include)

| Check | When to Include |
|-------|----------------|
| VR-BUILD | ALWAYS |
| VR-TYPE | ALWAYS |
| VR-TEST | ALWAYS (CR-21) |
| VR-FILE | When files created |
| VR-GREP | When code added |
| VR-NEGATIVE | When code removed |
| VR-SCHEMA | When DB changed |
| VR-DATA | When config-driven features touched |
| VR-RENDER | When UI components created |
| VR-COUPLING | When backend features added |
| VR-HANDLER | When buttons/actions added |
| VR-API-CONTRACT | When frontend calls backend |
| VR-PLAN-COVERAGE | When implementing a plan |
| VR-SPEC-MATCH | When UI items specify CSS classes/structure (CR-42) |
| VR-PIPELINE | When data pipeline features implemented (CR-43) |
| VR-RUNTIME | After all other checks pass |

Do NOT start verification until VR-PLAN is complete with all domains, checks, targets, and execution order.

---

## COMPLETION CRITERIA

Massu Loop is COMPLETE **only when BOTH gates pass: Code Quality AND Plan Coverage**.

### GATE 1: Code Quality Verification (All Must Pass in SAME Audit Run)
- [ ] All phases executed, all checkpoints passed with zero gaps
- [ ] Pattern scanner: Exit 0
- [ ] Type check: 0 errors
- [ ] Build: Exit 0
- [ ] Lint: Exit 0
- [ ] Prisma validate: Exit 0
- [ ] Tests: ALL PASS (MANDATORY)
- [ ] Security: No secrets staged
- [ ] VR-RENDER: All UI components rendered in pages

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
| Code Quality | PASS/FAIL | Pattern scanner, build, types |
| Plan Coverage | PASS/FAIL | X/Y items (Z%) |

**RESULT: COMPLETE** (only if both PASS)
```

**Code Quality: PASS + Plan Coverage: FAIL = NOT COMPLETE**

### Additional Verification
- [ ] User Flow: ALL buttons, navigation, props, callbacks, state, e2e flows verified
- [ ] Component Reuse: Checked existing before creating new
- [ ] DB verified: all environments
- [ ] Session state shows COMPLETED
- [ ] Phase archives created
- [ ] Help site updated for user-facing changes (or N/A)
- [ ] Plan document completion table added at TOP

---

## COMPLETION OUTPUT

```markdown
## [MASSU LOOP - COMPLETE]

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
| Pattern scanner | `./scripts/pattern-scanner.sh` | Exit 0 |
| Type check | `npx tsc --noEmit` | 0 errors |
| Build | `npm run build` | Exit 0 |
| DB (DEV) | VR-SCHEMA | VERIFIED |
| DB (PROD) | VR-SCHEMA | VERIFIED |

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
