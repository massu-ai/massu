---
name: massu-verify-playwright
description: "When user says 'check pages', 'scan for console errors', 'verify playwright', or needs to browser-test pages for console errors and generate a fix plan"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), mcp__plugin_playwright_playwright__*
disable-model-invocation: true
---
name: massu-verify-playwright

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding.

# Massu Verify Playwright: Page Console Error Scanner

## Objective

Open a Playwright browser, navigate to ALL target pages, collect console errors, and produce a structured report with a categorized fix plan. This command **REPORTS ONLY** -- it never auto-fixes anything.

---

## NON-NEGOTIABLE RULES

- **Report only** - NEVER auto-fix errors. All fixes go into the plan document for user review.
- **Every page checked** - Do not skip pages even if they appear similar.
- **Exact error capture** - Record full console error messages, not summaries.
- **Categorize errors** - Every error must be assigned a category and priority.
- **Authentication required** - If not logged in, STOP immediately and instruct the user.
- **Complete even if slow** - Do not abort early due to page count. Check every page in the list.

---

## ZERO-GAP AUDIT LOOP

**Console error verification does NOT complete until ALL pages are checked and a complete report is generated.**

```
Loop:
  1. Launch Playwright and verify authentication (if applicable)
  2. Check ALL pages in the mode (Quick or Full)
  3. Capture ALL console errors - every page, no skipping
  4. Categorize each error (Critical/High/Medium/Low)
  5. Generate complete report with:
     - Every error listed with full message
     - Priority ranking
     - File/line references where available
     - Fix recommendations for each error
  6. Only when ALL pages are checked: report complete
```

**GAPS_DISCOVERED semantics**: Every console error found = 1 gap. A complete pass finding no new errors proves correctness.

**The purpose of this command is REPORTING, not fixing. Present the full report to the user.**

---

## TWO MODES

| Mode | Flag | Pages | When to Use |
|------|------|-------|-------------|
| **Quick** | (default) | Error-prone pages | Daily health check |
| **Full** | `--full` | ALL pages | Pre-release audit, periodic deep scan |

Check the user's input for `--full` flag. If absent, use Quick mode.

---

## PHASE 0: LAUNCH PLAYWRIGHT AND VERIFY AUTH

### 0.1 Navigate to Target URL

The user provides the base URL or page list. Navigate to the first page:

```
Navigate to: [user-provided URL or localhost]
```

Use `mcp__plugin_playwright_playwright__browser_navigate` to open the URL.

### 0.2 Check Application Status

After navigation, use `mcp__plugin_playwright_playwright__browser_snapshot` to capture the page state.

**Check for these indicators:**

| Indicator | Meaning | Action |
|-----------|---------|--------|
| Page content visible | App loaded | PROCEED |
| URL redirected to `/login` or auth page | Not logged in | STOP |
| Error page or blank | App not running | STOP |

### 0.3 If NOT Ready

**STOP IMMEDIATELY.** Output the following message and terminate:

```
AUTHENTICATION REQUIRED (or APPLICATION NOT READY)

The Playwright browser cannot access the target application.

Please:
1. The Playwright browser window should be open
2. Log in to the target application manually in that browser (if auth required)
3. Wait until you see the expected page loaded
4. Re-run: /massu-verify-playwright

The command cannot proceed without access to the target pages.
```

**Do NOT attempt to automate login. Do NOT proceed without a loaded page.**

### 0.4 If Ready

Report to the user:

```
Application confirmed. Starting page scan...
Mode: [Quick / Full]
Pages to check: [N]
```

---

## PHASE 1: COLLECT CONSOLE ERRORS FROM EACH PAGE

### 1.1 Page Lists

The user provides page lists, OR use the application's sitemap/route analysis.

#### Quick Mode Pages (example)

```
/
/pricing
/features
/docs
/blog
```

#### Full Mode Pages

All pages discovered from sitemap, route analysis, or user-provided list.

### 1.2 Per-Page Procedure

For EACH page in the list, execute these steps in order:

**Step 1: Navigate**

```
Use mcp__plugin_playwright_playwright__browser_navigate to go to:
{base_url}{page_path}
```

**Step 2: Wait for Loading to Complete**

Use `mcp__plugin_playwright_playwright__browser_wait_for` or a brief pause (up to 10 seconds) to allow:
- Loading spinners to disappear
- Data to populate
- Any lazy-loaded components to render

If the page does not finish loading within 10 seconds, record it as a timeout and proceed.

**Step 3: Collect Console Messages**

Use `mcp__plugin_playwright_playwright__browser_console_messages` to retrieve ALL console messages.

Filter for messages at the **error** level only. Ignore warnings, info, and debug messages.

**Step 4: Record Results**

For each page, record:

| Field | Value |
|-------|-------|
| Page URL | The full path (e.g., `/docs/getting-started`) |
| Status | `clean` / `errors` / `timeout` / `404` |
| Error Count | Number of console errors |
| Error Messages | Full text of each error message |
| Load Time | Approximate (fast / slow / timeout) |

**Step 5: Move to Next Page**

Proceed to the next page in the list. Do NOT stop on errors.

### 1.3 Progress Reporting

After every 10 pages (or after all pages if fewer than 10 remain), provide a brief progress update to the user:

```
Progress: [X]/[TOTAL] pages checked | [Y] clean | [Z] with errors
```

---

## PHASE 2: GENERATE THE REPORT

### 2.1 Summary Table

```markdown
## Page Health Report

**Date**: [YYYY-MM-DD HH:MM]
**Mode**: Quick / Full
**Base URL**: [URL]

### Summary

| Metric | Count |
|--------|-------|
| Total Pages Checked | [N] |
| Clean Pages (0 errors) | [N] |
| Pages with Errors | [N] |
| Pages with Timeout | [N] |
| Pages with 404 | [N] |
| Total Console Errors | [N] |
```

### 2.2 Error Categories

Categorize EVERY console error into one of these categories:

| Category | Pattern to Match | Priority |
|----------|-----------------|----------|
| **API 500** | `500`, `Internal Server Error`, `failed to fetch` | P0 |
| **React Crash** | `Uncaught Error`, `Cannot read properties of`, `TypeError` | P0 |
| **Missing Module** | `is not defined`, `Cannot find module` | P1 |
| **i18n Missing** | `Missing message`, `MISSING_MESSAGE`, `IntlError` | P2 |
| **Realtime** | `realtime`, `subscription`, `websocket`, `channel` | P2 |
| **404 Resource** | `404`, `Not Found`, failed resource loads | P2 |
| **Deprecation** | `deprecated`, `will be removed` | P3 |
| **Other** | Anything not matching above | P2 |

### 2.3 Category Summary Table

```markdown
### Errors by Category

| Category | Count | Priority | Example |
|----------|-------|----------|---------|
| API 500 | [N] | P0 | [first error snippet] |
| React Crash | [N] | P0 | [first error snippet] |
| Missing Module | [N] | P1 | [first error snippet] |
| i18n Missing | [N] | P2 | [first error snippet] |
| Realtime | [N] | P2 | [first error snippet] |
| 404 Resource | [N] | P2 | [first error snippet] |
| Deprecation | [N] | P3 | [first error snippet] |
| Other | [N] | P2 | [first error snippet] |
```

### 2.4 Per-Page Error Details

For EACH page that had errors, produce a detail block:

```markdown
### /docs/getting-started

**Status**: errors
**Error Count**: [N]
**Load Time**: fast / slow / timeout

#### Errors

| # | Category | Priority | Message |
|---|----------|----------|---------|
| 1 | Missing Module | P1 | Module 'lodash' is not defined |
| 2 | API 500 | P0 | Failed to fetch: /api/data |
```

### 2.5 Clean Pages List

```markdown
### Clean Pages (0 Errors)

| # | Page |
|---|------|
| 1 | / |
| 2 | /pricing |
| ... | ... |
```

---

## PHASE 3: GENERATE THE FIX PLAN

### 3.1 Fix Plan Structure

For each unique error (deduplicated across pages), propose a fix:

```markdown
## Fix Plan

### Priority Levels

| Priority | Definition | Action |
|----------|------------|--------|
| **P0** | Crashes, 500 errors, data loss risk | Fix immediately |
| **P1** | Missing features, broken functionality | Fix this sprint |
| **P2** | Console noise, missing translations | Fix when convenient |
| **P3** | Deprecation warnings, cosmetic | Backlog |

---

### P0 Fixes (Critical)

#### FIX-001: [Error Description]

- **Pages Affected**: /docs, /blog
- **Error**: `[Full error message]`
- **Category**: API 500
- **Likely Root Cause**: [Analysis based on error message and codebase knowledge]
- **Proposed Fix**: [Description of fix]
- **Files to Investigate**:
  - `packages/core/src/[module].ts` - Check handler
  - `src/app/[path]/page.tsx` - Check component
- **Estimated Effort**: Small / Medium / Large

---

### P1 Fixes (High)

#### FIX-002: [Error Description]

[Same structure as above]

---

### P2 Fixes (Medium)

#### FIX-003: [Error Description]

[Same structure as above]

---

### P3 Fixes (Low)

#### FIX-004: [Error Description]

[Same structure as above]
```

### 3.2 Deduplication Rules

- If the same error appears on multiple pages, create ONE fix entry listing all affected pages.
- If multiple errors share the same root cause (e.g., all i18n errors from same namespace), group them into ONE fix entry.
- Always list the total count of occurrences.

### 3.3 Fix Plan Metadata

```markdown
### Fix Plan Summary

| Priority | Fix Count | Estimated Effort |
|----------|-----------|-----------------|
| P0 | [N] | [hours/days] |
| P1 | [N] | [hours/days] |
| P2 | [N] | [hours/days] |
| P3 | [N] | [hours/days] |
| **Total** | **[N]** | **[total]** |
```

---

## PHASE 4: SAVE AND PRESENT

### 4.1 Save the Plan Document

Save the complete report + fix plan to:

```
docs/plans/[YYYY-MM-DD]-playwright-verification-fixes.md
```

The document should contain:
1. The full report (Phase 2 output)
2. The full fix plan (Phase 3 output)
3. A header with metadata

### 4.2 Document Header

```markdown
# Playwright Page Verification Report

**Generated**: [YYYY-MM-DD HH:MM]
**Mode**: [Quick / Full]
**Pages Checked**: [N]
**Total Errors Found**: [N]
**Fix Plan Items**: [N]

## Status: AWAITING REVIEW

> This report was generated by `/massu-verify-playwright`.
> Review the fix plan below and approve/modify before executing fixes.
>
> To execute approved fixes, run:
> - `/massu-loop` with this plan for systematic implementation
> - `/massu-hotfix` for individual P0 fixes that need immediate attention
```

### 4.3 Present to User

After saving, present to the user:

1. The summary table (pages checked, error counts)
2. The category breakdown
3. The fix plan summary (priority counts)
4. The file path where the full report was saved
5. Ask for review/comments/approval before proceeding with any fixes

```markdown
## Next Steps

1. Review the fix plan at: [file path]
2. Comment on any fixes you want to modify, skip, or reprioritize
3. When ready, run `/massu-loop` or `/massu-hotfix` to execute the approved fixes
4. Re-run `/massu-verify-playwright` after fixes to verify resolution

**This command does NOT auto-fix anything. All fixes require your approval.**
```

---

## ERROR HANDLING

### Page Navigation Failures

| Scenario | Action |
|----------|--------|
| Page returns 404 | Record as `404`, continue to next page |
| Page hangs (>10s) | Record as `timeout`, continue to next page |
| Page redirects to /login | Session expired. STOP and report to user. |
| Network error | Retry once. If still fails, record and continue. |

### Session Expiration Mid-Scan

If at any point during the scan, the browser is redirected to `/login`:

1. STOP the scan immediately
2. Report how many pages were completed
3. Save partial results
4. Tell the user to log in again and re-run

### Playwright Not Available

If Playwright MCP tools are not available:

```
ERROR: Playwright MCP tools are not available in this session.

Please ensure the Playwright MCP server is running and try again.
```

---

## REPORT FORMAT TEMPLATE

The complete saved document should follow this structure:

```markdown
# Playwright Page Verification Report

**Generated**: [YYYY-MM-DD HH:MM]
**Mode**: [Quick / Full]
**Pages Checked**: [N]
**Total Errors Found**: [N]
**Fix Plan Items**: [N]

## Status: AWAITING REVIEW

---

## 1. Summary

[Phase 2.1 Summary Table]

## 2. Errors by Category

[Phase 2.3 Category Summary Table]

## 3. Pages with Errors

[Phase 2.4 Per-Page Error Details - one section per error page]

## 4. Clean Pages

[Phase 2.5 Clean Pages List]

## 5. Fix Plan

[Phase 3 Fix Plan with all priority levels]

## 6. Fix Plan Summary

[Phase 3.3 Fix Plan Metadata]

---

## Next Steps

- Review this plan and approve/modify fixes
- Run `/massu-loop` with this plan for systematic implementation
- Run `/massu-hotfix` for individual P0 fixes needing immediate attention
- Re-run `/massu-verify-playwright` after fixes to verify resolution
```

---

## AUTO-LEARNING PROTOCOL (MANDATORY after every fix/finding)

**After EVERY fix or finding, the system MUST automatically learn. This is NOT optional.**

### Step 1: Ingest into Memory
Use `mcp__massu-codegraph__massu_memory_ingest` with type="bugfix"|"pattern", description of what was found/fixed, affected files, and importance (5=security/data, 3=build/type, 2=cosmetic).

### Step 2: Record Correct vs Incorrect Pattern
Update session state with the WRONG vs CORRECT pattern discovered.

### Step 3: Add to Pattern Scanner (if grep-able)
If the bad pattern is detectable by grep, add check to `scripts/massu-pattern-scanner.sh`.

### Step 4: Search Codebase-Wide (CR-9)
`grep -rn "[bad_pattern]" packages/core/src/ src/` - fix ALL instances of the same issue.

---

## START NOW

1. Check user input for `--full` flag to determine mode
2. Launch Playwright and navigate to target URL
3. Verify application is ready (STOP if not)
4. Iterate through ALL pages in the selected list
5. Collect console errors from each page
6. Generate the categorized report
7. Generate the prioritized fix plan
8. Save to docs directory
9. Present summary and ask for user review

**Remember: Report everything. Fix nothing. Let the user decide.**
