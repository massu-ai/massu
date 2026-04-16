---
name: massu-gap-enhancement-analyzer
description: "When user says 'analyze gaps', 'find enhancements', 'gap analysis', or has completed a massu-loop implementation and needs to identify remaining gaps and enhancement opportunities"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), Task(*)
---
name: massu-gap-enhancement-analyzer

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-12, CR-45 enforced.

# Massu Gap & Enhancement Analyzer — Zero-Gap Loop

## Objective

Run a continuous analysis→fix→re-analysis loop that catches everything implementation missed: incomplete features, missing edge cases, UX gaps, untested paths, security issues, and enhancement opportunities.

**ALL gaps and enhancements found MUST be fixed/implemented — no severity is exempt (CR-45).**

**This command loops until a FULL PASS discovers ZERO gaps AND ZERO enhancements.**

---

## WHEN TO USE THIS COMMAND

- **Standalone**: After a plan has been implemented via `/massu-loop` or manual implementation
- **Inside golden path**: Invoked automatically as Phase 2.5
- **Ad hoc**: Any time you want to sweep a codebase area for gaps and enhancements

---

## INPUT REQUIREMENTS

The user MUST provide:
1. **Plan file path**: The original plan document that was implemented

If not provided, ask for the plan path before proceeding.

---

## THIS IS A LOOP CONTROLLER

**Your job is to:**
1. Spawn a `general-purpose` subagent for ONE complete analysis-and-fix pass
2. Parse the structured result (`GAPS_DISCOVERED: N`)
3. If gaps discovered > 0: spawn ANOTHER full pass (even if all gaps were fixed)
4. Only when a COMPLETE FRESH PASS discovers ZERO gaps can you declare complete

**You are NOT the analyzer. You are the LOOP. The analyzer runs inside Task subagents.**

---

## CRITICAL: GAPS_DISCOVERED Semantics

**`GAPS_DISCOVERED` = total gaps + enhancements FOUND during the pass, REGARDLESS of whether they were also fixed.**

| Scenario | GAPS_DISCOVERED | Loop Action |
|----------|----------------|-------------|
| Pass finds 0 gaps/enhancements | 0 | **EXIT** — analysis complete |
| Pass finds 12 gaps, fixes all 12 | **12** (NOT 0) | **CONTINUE** — must re-analyze |
| Pass finds 5 gaps, fixes 3, 2 need controller | **5** | **CONTINUE** — fix remaining, re-analyze |

**THE RULE**: A clean pass means zero issues DISCOVERED from the start. Fixing gaps during a pass does NOT make it a clean pass. Only a fresh pass starting clean and finding nothing wrong proves the implementation is complete.

---

## MANDATORY LOOP CONTROLLER (EXECUTE THIS — DO NOT SKIP)

```
PLAN_PATH = $ARGUMENTS (the plan file path)
iteration = 0
MAX_ITERATIONS = 10

WHILE iteration < MAX_ITERATIONS:
  iteration += 1

  result = Task(subagent_type="general-purpose", prompt="
    Gap & Enhancement Analysis — Iteration {iteration}

    CONTEXT:
    - Plan file: {PLAN_PATH}
    - Implementation is COMPLETE
    - Your job: find ALL gaps and enhancements, then FIX every one

    INSTRUCTIONS:
    1. Read the plan file from disk
    2. Read CLAUDE.md for rules and patterns
    3. Review ALL files changed: git diff origin/main --name-only (or git diff HEAD~10 --name-only)
    4. Run ALL analysis categories below (A through H)
    5. For EACH gap/enhancement found: FIX IT immediately
    6. Verify each fix (build, type-check, test as appropriate)
    7. Report GAPS_DISCOVERED as total FOUND (even if all fixed)

    ANALYSIS CATEGORIES:

    A. FUNCTIONAL GAPS
    - Missing error handling (try/catch, error boundaries, fallbacks)
    - Missing loading states (spinners, skeletons, disabled buttons)
    - Missing empty states ('No items found' messaging)
    - Missing null/undefined guards on nullable fields
    - Missing input validation (required fields, format, bounds)
    - Incomplete CRUD (create exists but no edit/delete, or vice versa)
    - Missing timeout wrappers on async calls (asyncio.timeout)
    - Missing concurrency limits on external clients (semaphores)

    B. UX GAPS
    - Missing success feedback after mutations
    - Missing confirmation for destructive actions
    - Missing keyboard navigation
    - Missing responsive behavior
    - Inconsistent spacing or layout
    - Missing breadcrumbs or navigation context
    - User-unfriendly error messages (must be human-readable)

    C. DATA INTEGRITY GAPS
    - Optimistic updates without rollback
    - Missing cache invalidation after mutations
    - Stale data after navigation
    - Missing pagination for large datasets
    - Unhandled serialization edge cases

    D. SECURITY GAPS
    - Missing auth checks on mutations
    - Missing input validation on API inputs
    - Missing access control policies on new tables/resources
    - Exposed sensitive data in responses
    - Service token auth ordering (must precede auth bypass)

    E. PATTERN COMPLIANCE
    - Check for pattern violations against CLAUDE.md rules
    - Verify naming conventions (snake_case, PascalCase, etc.)
    - Check for hardcoded values that should be configurable
    - Verify async patterns (lazy lock init, strong task refs, timeouts)

    F. ENHANCEMENT OPPORTUNITIES
    - Type safety improvements (replace Any with proper types)
    - Code deduplication (extract shared logic)
    - Performance optimizations (caching, batching, lazy loading)
    - Accessibility improvements (aria-labels, focus management)
    - Better logging (WARNING for dropped data, structured log levels)

    G. E2E WIRING GAPS
    - For each data flow, verify the complete chain:
      WRITE: mutation/action reachable from UI or scheduler
      STORE: data persists to real storage
      READ: query reads from that same storage
      DISPLAY: component/log renders the data
    - Background features: WRITE->STORE->READ sufficient
    - Query-only features: READ->DISPLAY sufficient

    H. TEST COVERAGE GAPS
    - Files without corresponding tests
    - Tests behind guards that don't mock the guard
    - Missing edge case tests (empty input, max bounds, error paths)
    - Missing integration tests for multi-stage pipelines

    FOR EACH FINDING:
    1. Classify: GAP or ENHANCEMENT
    2. Severity: P0 (broken/security) / P1 (incorrect/major) / P2 (polish/minor)
    3. FIX IT immediately
    4. Verify the fix works

    CRITICAL INSTRUCTION FOR GAPS_DISCOVERED:
    Report GAPS_DISCOVERED as the total number of issues you FOUND during this pass,
    EVEN IF you also fixed them. Finding 12 issues and fixing all 12 = GAPS_DISCOVERED: 12.
    A clean pass that finds nothing wrong from the start = GAPS_DISCOVERED: 0.

    Return the structured result block at the end:
    ---STRUCTURED-RESULT---
    ITERATION: {iteration}
    GAPS_DISCOVERED: [number]
    ENHANCEMENTS_DISCOVERED: [number]
    TOTAL_ISSUES: [number]  (gaps + enhancements)
    ITEMS_FIXED: [number]
    ITEMS_REMAINING: [number]
    ---END-RESULT---
  ")

  # Parse structured result
  gaps = parse TOTAL_ISSUES from result (fallback: GAPS_DISCOVERED)

  # Report iteration to user
  Output: "Iteration {iteration}: {gaps} issues discovered"

  IF gaps == 0:
    Output: "GAP ANALYSIS COMPLETE — Clean pass with zero issues in iteration {iteration}"
    BREAK
  ELSE:
    Output: "{gaps} issues discovered (and fixed) in iteration {iteration}, starting fresh re-analysis..."
    CONTINUE

IF iteration == MAX_ITERATIONS AND gaps > 0:
  Output: "WARNING: Gap analyzer did not converge after {MAX_ITERATIONS} iterations. {gaps} issues remain."
```

---

## RULES FOR THE LOOP CONTROLLER

| Rule | Meaning |
|------|---------|
| **NEVER output a final verdict while gaps > 0** | Only a zero-issue-from-start iteration produces the final report |
| **NEVER treat "found and fixed" as zero gaps** | Fixing during a pass still means gaps were discovered |
| **NEVER ask user "should I continue?"** | The loop is mandatory |
| **NEVER stop after fixing gaps** | Requires a FRESH re-analysis to verify |
| **ALWAYS use Task tool for analysis passes** | Subagents keep context clean |
| **ALWAYS parse GAPS_DISCOVERED from result** | This is the loop control variable |
| **Maximum 10 iterations** | If still failing after 10, report to user |
| **Enhancements are NOT optional** | All enhancements MUST be implemented (CR-45) |
| **No severity exemptions** | CRITICAL through MINOR, all get fixed |

---

## ANALYSIS DETAIL: PLAN EXTRACTION (Subagent does this in each pass)

### Plan Inventory

The subagent reads the plan and extracts ALL items:

| Category | What to Extract |
|----------|-----------------|
| **Database** | Tables, columns, migrations, policies, grants |
| **API/Routers** | Endpoints, inputs, outputs, mutations, queries |
| **Components** | UI components, locations, dependencies |
| **Features** | User-facing functionality, workflows, integrations |
| **Configuration** | Environment variables, feature flags, settings |
| **Tests** | Test files, coverage requirements |

### Gap Categories

| Category | Definition | Severity |
|----------|------------|----------|
| **CRITICAL** | Feature doesn't work, data loss risk, security issue | P0 |
| **COUPLING** | Backend feature not exposed in UI (users can't access it) | P0 |
| **MAJOR** | Significant functionality missing, UX broken | P1 |
| **MINOR** | Small missing piece, cosmetic issue | P2 |
| **ENHANCEMENT** | Improvement opportunity beyond original scope | P2 |

### Backend-Frontend Coupling (VR-COUPLING)

**MANDATORY**: Verify ALL backend features are exposed in frontend.

| Backend Item | Frontend Requirement |
|--------------|---------------------|
| Enum values in router | SELECT/UI options match |
| New API endpoint | UI component calls it |
| Input schema fields | Form has all fields |
| Response fields | Display component renders them |

---

## POST-LOOP: REPORT GENERATION

After the loop exits with zero gaps, generate a final summary report.

### Report Storage

```
reports/gap-analysis/[YYYY-MM-DD]-[plan-name-slug]-gap-analysis.md
```

### Report Contents

```markdown
---
title: Gap & Enhancement Analysis Report
plan: [PLAN_FILE_PATH]
analyzed_date: [YYYY-MM-DD HH:MM]
analyzer: massu-gap-enhancement-analyzer v2.0 (loop-until-zero)
iterations: [N]
---

# Gap & Enhancement Analysis Report

## Executive Summary

| Metric | Count |
|--------|-------|
| Total Iterations | [N] |
| Total Gaps Found (all iterations) | [G] |
| Total Enhancements Found (all iterations) | [E] |
| All Fixed | YES |
| Clean Pass | Iteration [N] |

## Iteration Log

| Iteration | Gaps | Enhancements | Fixed | Status |
|-----------|------|--------------|-------|--------|
| 1 | [N] | [N] | [N] | CONTINUE |
| 2 | [N] | [N] | [N] | CONTINUE |
| ... | | | | |
| [final] | 0 | 0 | 0 | CLEAN PASS |

## Items Fixed (All Iterations)

| # | Type | Severity | Description | File | Iteration |
|---|------|----------|-------------|------|-----------|
| 1 | GAP | P0 | [description] | [file] | 1 |
| 2 | ENHANCEMENT | P2 | [description] | [file] | 1 |

---
*Generated by massu-gap-enhancement-analyzer v2.0 (loop-until-zero)*
```

### Report Index

Update `reports/gap-analysis/INDEX.md`:

```markdown
| Date | Plan | Iterations | Gaps Fixed | Enhancements | Report |
|------|------|------------|------------|--------------|--------|
| [date] | [plan] | [N] | [G] | [E] | [link] |
```

---

## EXECUTION FLOW

```
START
  |
  v
[Parse plan path from $ARGUMENTS]
  |
  v
[LOOP ITERATION 1]
  - Spawn subagent
  - Subagent: read plan, read CLAUDE.md, analyze categories A-H
  - Subagent: fix ALL issues found
  - Subagent: return GAPS_DISCOVERED count
  |
  v
[GAPS > 0?] --YES--> [LOOP ITERATION 2] --> ...
  |
  NO
  |
  v
[GENERATE FINAL REPORT]
  - Save to reports/gap-analysis/
  - Update INDEX.md
  |
  v
[OUTPUT: Zero-gap certification + report location]
```

---

## START NOW

1. Parse plan file path from `$ARGUMENTS`
2. Start the loop: spawn subagent for iteration 1
3. Parse `GAPS_DISCOVERED` / `TOTAL_ISSUES` from the result
4. If > 0: spawn another iteration (DO NOT ASK — loop is mandatory)
5. If == 0: generate report, output final summary
6. Continue until zero or max 10 iterations
