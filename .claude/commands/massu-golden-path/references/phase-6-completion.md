# Phase 6: Completion

> Reference doc for `/massu-golden-path`. Return to main file for overview.

## 6.1 Final Report

```
===============================================================================
GOLDEN PATH COMPLETE
===============================================================================

SUMMARY:
--------------------------------------------------------------------------
Phase 0: Requirements & Context    D1-D10 resolved
Phase 1: Plan Creation & Audit     [N] items, [M] audit passes
Phase 2: Implementation            [N] audit loops, 3 reviewers passed
Phase 2A.5: Sprint Contracts       [N] contracts negotiated, [M] criteria total
Phase 2C.2: QA Evaluator           [N] sprints evaluated, [M] bugs caught / SKIPPED (no UI)
Phase 2G: Browser Verification     [N] pages tested, [M] issues fixed / SKIPPED
Phase 2.5: Gap & Enhancement       [N] iterations, [M] gaps fixed, [K] enhancements
Phase 3: Simplification            [N] findings fixed
Phase 4: Pre-Commit Verification   13 gates passed
Phase 5: Push Verification         3 tiers passed, 0 regressions
Phase 5.5: Production Verification [N]/[M] immediate PASS, [K] deferred pending
--------------------------------------------------------------------------

DELIVERABLES:
  Plan: [plan path]
  Commit: [hash]
  Branch: [branch]
  Pushed: YES
  Production: [VERIFIED / VERIFIED + DEFERRED / BLOCKED]
  Files changed: [N]

===============================================================================
```

## 6.2 Plan Document Update (MANDATORY)

Add to TOP of plan document:

```markdown
# IMPLEMENTATION STATUS

**Plan**: [Name]
**Status**: COMPLETE -- PRODUCTION VERIFIED / COMPLETE -- PENDING DEFERRED VERIFICATION
**Last Updated**: [YYYY-MM-DD HH:MM]
**Push Commit**: [hash]
**Production Verified**: [YYYY-MM-DD HH:MM] / PENDING (deferred items in session-state/deferred-verifications.md)
**Completed By**: Claude Code (Massu Golden Path)

## Task Completion Summary
| # | Task/Phase | Status | Verification | Date |
|---|------------|--------|--------------|------|
| 1 | [description] | 100% COMPLETE | VR-BUILD: Pass | [date] |
```

## 6.2.1 Sprint Contract Results (if Phase 2A.5 was executed)

Add after Task Completion Summary:

```markdown
## Sprint Contract Results
| Item | Criteria Count | Met | Unmet | Renegotiated | Final Status |
|------|---------------|-----|-------|--------------|--------------|
| P-XXX | N | N | 0 | 0 | FULFILLED |

**Contracts Fulfilled**: N/N (100%)
**Criteria Met**: N/N total acceptance criteria
**Renegotiations**: N (with reasons documented in tracking table)
```

Skip this section if no sprint contracts were negotiated (Phase 2A.5 skipped).

## 6.2.2 QA Evaluator Summary (if Phase 2C.2 was executed)

Add after Sprint Contract Results:

```markdown
## QA Evaluator Summary
| Sprint | Product Depth | Functionality | Visual Design | Code Quality | Bugs Found | Verdict |
|--------|--------------|---------------|---------------|-------------|------------|---------|
| 1 | 4 | 3 | 4 | 4 | 2 | PASS |

**Sprints Evaluated**: N
**Total Bugs Caught by QA**: N (N fixed before merge)
**Average Scores**: PD=X.X FN=X.X VD=X.X CQ=X.X
**QA Gate Failures**: N (required re-implementation)
```

Skip this section if the plan had no UI files (QA evaluator not triggered).

## 6.3 Auto-Learning Protocol (MANDATORY)

1. Review ALL fixes: `git diff origin/main..HEAD`
2. For each fix: verify ingested into limn memory (`massu_memory_ingest`)
3. For each fix: verify MEMORY.md updated
4. For each new pattern: verify recorded
5. For each failed approach: verify recorded as `failed_attempt`
6. Record user corrections to `memory/corrections.md`
7. Consider new CR rule if a class of bug was found

## 6.4 Quality & Observability Report

Generate: `massu_quality_score`, `massu_quality_trend`, `massu_quality_report`, `massu_prompt_effectiveness`, `massu_session_stats`, `massu_prompt_analysis`, `massu_tool_patterns`.

## 6.5 Feature Registration (CR-32)

Call `massu_sentinel_register` with feature name, file list, domain, test status.

## 6.6 Update Session State

Update `session-state/CURRENT.md` with completion status.
