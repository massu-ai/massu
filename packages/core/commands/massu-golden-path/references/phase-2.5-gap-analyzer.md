# Phase 2.5: Gap & Enhancement Analyzer Loop

> Reference doc for `/massu-golden-path`. Return to main file for overview.

```
[GOLDEN PATH -- PHASE 2.5: GAP & ENHANCEMENT ANALYSIS]
```

## Purpose

After implementation (Phase 2) completes successfully, run a continuous gap and enhancement analysis loop. This phase catches everything implementation missed: incomplete features, missing edge cases, UX gaps, untested paths, accessibility issues, and enhancement opportunities.

**This phase loops until a FULL PASS discovers ZERO gaps/enhancements.**

---

## LOOP CONTROLLER

```
iteration = 0
MAX_ITERATIONS = 10

WHILE iteration < MAX_ITERATIONS:
  iteration += 1

  result = Task(subagent_type="gap-analyzer", prompt="
    Gap & Enhancement Analysis -- Iteration {iteration}

    CONTEXT:
    - Plan file: {PLAN_PATH}
    - Implementation is COMPLETE (Phase 2 passed)
    - Your job: find gaps and enhancements the implementation missed

    INSTRUCTIONS:
    1. Read the plan from disk
    2. Read CLAUDE.md and relevant patterns
    3. Review ALL files changed in this session: git diff origin/main --name-only
    4. Run the analysis categories below
    5. For each gap/enhancement found: FIX IT immediately
    6. Report GAPS_DISCOVERED as total found (even if fixed)

    ANALYSIS CATEGORIES:

    A. FUNCTIONAL GAPS
    - Missing error handling (try/catch, error boundaries, toast notifications)
    - Missing loading states (Skeleton, Spinner, disabled buttons during submit)
    - Missing empty states ('No items found' messaging)
    - Missing null guards on nullable fields
    - Missing form validation (required fields, format validation)
    - Incomplete CRUD (create exists but no edit/delete, or vice versa)

    B. UX GAPS
    - Missing success feedback after mutations (toast.success)
    - Missing confirmation for destructive actions (AlertDialog)
    - Missing keyboard navigation (tabIndex, onKeyDown for Enter)
    - Missing responsive behavior (sm:/md:/lg: breakpoints)
    - Inconsistent spacing (layout classes, gap values)
    - Missing breadcrumbs or navigation context

    C. DATA INTEGRITY GAPS
    - Optimistic updates without rollback
    - Missing query invalidation after mutations
    - Stale data after navigation (missing refetch)
    - Missing pagination for large datasets
    - Unhandled serialization edge cases

    D. SECURITY GAPS
    - Missing input validation on handler inputs
    - Exposed sensitive data in responses
    - Missing access controls on new endpoints

    E. PATTERN COMPLIANCE
    - Run bash scripts/massu-pattern-scanner.sh on changed files
    - Check for ESM compliance (.ts extensions, no require())
    - Check for config-driven patterns (no hardcoded project-specific values)
    - Check for TypeScript strict mode compliance

    F. ENHANCEMENT OPPORTUNITIES
    - Type safety improvements (replace 'any' with proper types)
    - Code deduplication (extract shared logic)
    - Performance (unnecessary re-renders, missing caching)
    - Accessibility (aria-labels, alt text, focus management)

    FOR EACH FINDING:
    1. Classify: GAP (must fix) or ENHANCEMENT (should fix)
    2. Severity: P0 (broken) / P1 (incorrect) / P2 (polish)
    3. Fix it immediately
    4. Verify the fix

    RETURN STRUCTURED RESULT:
    ```
    GAPS_DISCOVERED: [N]
    ENHANCEMENTS_APPLIED: [N]
    ITEMS_FIXED: [N]

    | # | Type | Severity | Description | File | Fixed |
    |---|------|----------|-------------|------|-------|
    | 1 | GAP | P0 | Missing error boundary | src/... | YES |
    ```
  ")

  gaps = parse GAPS_DISCOVERED from result

  IF gaps == 0:
    Output: "Gap analysis clean in iteration {iteration} -- zero gaps found"
    BREAK
  ELSE:
    Output: "Iteration {iteration}: {gaps} gaps found and fixed, re-analyzing..."
    CONTINUE

IF iteration == MAX_ITERATIONS AND gaps > 0:
  Output: "WARNING: Gap analyzer did not converge after {MAX_ITERATIONS} iterations. {gaps} gaps remain."
```

---

## RULES

| Rule | Meaning |
|------|---------|
| **Fix during analysis** | The analyzer fixes gaps as it finds them, not just reports |
| **Full re-pass required** | After fixes, a fresh pass must find ZERO to exit |
| **P0 gaps block** | Any P0 gap that can't be fixed stops the golden path |
| **Enhancements are mandatory** | Enhancements found MUST be applied (this is golden path, not quick fix) |
| **Pattern scanner gates** | `bash scripts/massu-pattern-scanner.sh` must exit 0 after each iteration |
| **No new files without reason** | Don't create helper files that aren't needed |

---

## WHEN TO SKIP

This phase can be skipped ONLY if:
- The implementation was documentation-only (no source files changed)
- User explicitly says "skip gap analysis"

Otherwise, it runs automatically as part of the golden path.
