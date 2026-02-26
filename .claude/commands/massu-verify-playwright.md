---
name: massu-verify-playwright
description: Open Playwright browser and check pages for console errors, generate report and fix plan
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), mcp__plugin_playwright_playwright__*
---
name: massu-verify-playwright

# Massu Verify Playwright: Page Console Error Scanner

## Objective

Open a Playwright browser, navigate to pages, collect console errors, and produce a structured report with a categorized fix plan. This command **REPORTS ONLY** -- it never auto-fixes anything.

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

The user provides the base URL. For the Massu website:
```
Navigate to: http://localhost:3000 (dev) or the production URL
```

Use `mcp__plugin_playwright_playwright__browser_navigate` to open the URL.

### 0.2 Check Application Status

After navigation, use `mcp__plugin_playwright_playwright__browser_snapshot` to capture the page state.

**Check for these indicators:**

| Indicator | Meaning | Action |
|-----------|---------|--------|
| Page content visible | App loaded | PROCEED |
| URL redirected to `/login` | Not logged in | STOP and instruct user |
| Error page or blank | App not running | STOP and report |

### 0.3 If NOT Ready

**STOP IMMEDIATELY.** Output instructions for the user to prepare the application.

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

The user provides page lists, OR use the website sitemap. For the Massu website, common pages include:

#### Quick Mode (default)
```
/
/pricing
/features
/docs
/blog
```

#### Full Mode
All pages discovered from sitemap or route analysis.

### 1.2 Per-Page Procedure

For EACH page in the list, execute these steps in order:

**Step 1: Navigate**
Use `mcp__plugin_playwright_playwright__browser_navigate` to go to the page URL.

**Step 2: Wait for Loading to Complete**
Use `mcp__plugin_playwright_playwright__browser_wait_for` or a brief pause (up to 10 seconds).

**Step 3: Collect Console Messages**
Use `mcp__plugin_playwright_playwright__browser_console_messages` to retrieve ALL console messages.
Filter for messages at the **error** level only.

**Step 4: Record Results**

| Field | Value |
|-------|-------|
| Page URL | The full path |
| Status | `clean` / `errors` / `timeout` / `404` |
| Error Count | Number of console errors |
| Error Messages | Full text of each error message |
| Load Time | Approximate (fast / slow / timeout) |

**Step 5: Move to Next Page**
Proceed to the next page in the list. Do NOT stop on errors.

### 1.3 Progress Reporting

After every 10 pages (or after all pages if fewer than 10 remain):
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

| Category | Pattern to Match | Priority |
|----------|-----------------|----------|
| **API 500** | `500`, `Internal Server Error`, `failed to fetch` | P0 |
| **React Crash** | `Uncaught Error`, `Cannot read properties of`, `TypeError` | P0 |
| **Missing Module** | `is not defined`, `Cannot find module` | P1 |
| **404 Resource** | `404`, `Not Found`, failed resource loads | P2 |
| **Deprecation** | `deprecated`, `will be removed` | P3 |
| **Other** | Anything not matching above | P2 |

### 2.3 Per-Page Error Details

For EACH page that had errors, produce a detail block with error count, category, priority, and full message.

### 2.4 Clean Pages List

List all pages with zero errors.

---

## PHASE 3: GENERATE THE FIX PLAN

### 3.1 Fix Plan Structure

For each unique error (deduplicated across pages), propose a fix with:
- Pages affected
- Full error message
- Category and priority
- Likely root cause
- Proposed fix
- Files to investigate
- Estimated effort

### 3.2 Deduplication Rules

- Same error on multiple pages = ONE fix entry listing all affected pages
- Multiple errors with same root cause = ONE grouped fix entry
- Always list total occurrence count

---

## PHASE 4: SAVE AND PRESENT

### 4.1 Save the Plan Document

Save the complete report + fix plan to:
```
docs/plans/[YYYY-MM-DD]-playwright-verification-fixes.md
```

### 4.2 Present to User

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

| Scenario | Action |
|----------|--------|
| Page returns 404 | Record as `404`, continue to next page |
| Page hangs (>10s) | Record as `timeout`, continue to next page |
| Page redirects to /login | Session expired. STOP and report to user. |
| Network error | Retry once. If still fails, record and continue. |

### Playwright Not Available

If Playwright MCP tools are not available:
```
ERROR: Playwright MCP tools are not available in this session.

Please ensure the Playwright MCP server is running and try again.
```

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
