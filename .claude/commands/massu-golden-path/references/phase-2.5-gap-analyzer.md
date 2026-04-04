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
    Gap & Enhancement Analysis — Iteration {iteration}

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
    - Inconsistent spacing (page-container class, gap values)
    - Missing breadcrumbs or navigation context
    - VR-VISUAL weighted score < 3.0 on affected routes

    C. DATA INTEGRITY GAPS
    - Optimistic updates without rollback
    - Missing query invalidation after mutations
    - Stale data after navigation (missing refetch)
    - Missing pagination for large datasets
    - Unhandled BigInt/Decimal serialization

    D. SECURITY GAPS
    - Missing protectedProcedure on mutations
    - Missing input validation on router inputs
    - Missing RLS policies on new tables
    - Exposed sensitive data in client responses

    E. PATTERN COMPLIANCE
    - Run ./scripts/pattern-scanner.sh on changed files
    - Check for pattern violations
    - Check for hardcoded colors (should use design tokens)

    F. ENHANCEMENT OPPORTUNITIES
    - Type safety improvements (replace 'any' with proper types)
    - Code deduplication (extract shared logic)
    - Performance (unnecessary re-renders, missing useMemo/useCallback)
    - Accessibility (aria-labels, alt text, focus management)

    G. E2E WIRING GAPS
    - For each data flow in changed files, verify VR-ROUNDTRIP:
      WRITE: mutation/action reachable from UI or cron
      STORE: data persists in a real table
      READ: query reads from that same table
      DISPLAY: component renders the query data (or cron logs output)
    - Background-only features (crons, webhooks): WRITE->STORE->READ sufficient
    - Query-only features (read views): READ->DISPLAY sufficient

    I. RUNTIME & BOOT VERIFICATION (CR-44, Incident 2026-03-29)
    - For EACH service that was created, modified, or registered in this session:
      1. VR-DEPS: Verify .venv/bin/python3 exists (if plist references it)
      2. VR-DEPS: Parse imports from main.py, verify each is installed in the venv
      3. VR-COMPAT: Check for Python 3.10+ syntax (x | None, match/case) on Python 3.9 systems
      4. VR-BOOT: Actually start the service (launchctl bootstrap or direct python), wait 5s, verify:
         - Process is still alive (pgrep)
         - Exit code is 0 (launchctl list | grep service)
         - stderr log has no import errors or crashes
      5. If boot fails: read stderr log, diagnose (missing package? wrong path? syntax error?), fix, retry
    - Skip condition: plan has NO service/daemon/LaunchAgent items
    - This category exists because static verification (VR-SYNTAX, VR-GREP) cannot catch:
      missing venvs, missing pip packages, Python version incompatibilities, or runtime import errors

    H. SPRINT CONTRACT COMPLIANCE (if contracts exist from Phase 2A.5)
    - Read the sprint contracts from the Phase 2A tracking table
    - For EACH plan item with a sprint contract:
      1. List all acceptance criteria from the contract
      2. Verify EACH criterion with specific evidence (grep, screenshot, DOM state, network response)
      3. Any unmet criterion = GAP (P1 severity minimum)
    - Contract criteria are IN ADDITION TO categories A-G — both must pass
    - Skip condition: items marked `Contract: N/A` in the tracking table
    - If no sprint contracts were negotiated (Phase 2A.5 skipped), skip this category

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
    | 1 | GAP | P0 | Missing error boundary | src/app/.../page.tsx | YES |
    ```
  ")

  gaps = parse GAPS_DISCOVERED from result

  IF gaps == 0:
    Output: "Gap analysis clean in iteration {iteration} — zero gaps found"
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
| **Pattern scanner gates** | `./scripts/pattern-scanner.sh` must exit 0 after each iteration |
| **No new files without reason** | Don't create helper files that aren't needed |

---

## WHEN TO SKIP

This phase can be skipped ONLY if:
- The implementation was documentation-only (no source files changed)
- User explicitly says "skip gap analysis"

Otherwise, it runs automatically as part of the golden path.
