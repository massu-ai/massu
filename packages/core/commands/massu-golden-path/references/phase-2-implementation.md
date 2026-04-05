# Phase 2: Implementation

> Reference doc for `/massu-golden-path`. Return to main file for overview.

## Competitive Mode Check

```
IF --competitive flag:
  Read references/competitive-mode.md and execute Phase 2-COMP protocol
  SKIP Phase 2A-2G (competitive mode handles implementation differently)
  After winner selection, continue with Phase 2.5
ELSE:
  Execute standard Phase 2A-2G as below
```

---

## Phase 2A: Plan Item Extraction & Setup

```
[GOLDEN PATH -- PHASE 2: IMPLEMENTATION]
```

1. Read plan from disk (NOT memory -- CR-5)
2. Extract ALL deliverables into tracking table:

| Item # | Type | Description | Location | Verification | Status |
|--------|------|-------------|----------|--------------|--------|
| P1-001 | CONFIG | ... | ... | VR-CONFIG | PENDING |

3. Create VR-PLAN verification strategy:

| # | VR-* Check | Target | Why Applicable | Status |
|---|-----------|--------|----------------|--------|
| 1 | VR-BUILD | Full project | Always | PENDING |

4. Initialize session state with AUTHORIZED_COMMAND: massu-golden-path

---

## Phase 2B: Implementation Loop

For each plan item:
1. **Pre-check**: Verify file exists, read current state
2. **Execute**: Implement the item following established patterns
3. **Guardrail**: Run `bash scripts/massu-pattern-scanner.sh` (ABORT if fails)
4. **Verify**: Run applicable VR-* checks with proof
5. **VR-PIPELINE**: If the item involves a data pipeline (AI, cron, generation, ETL), trigger the pipeline manually, verify output is non-empty. Empty output = fix before continuing.
6. **Update**: Mark item complete in tracking table

**DO NOT STOP between items** unless:
- New pattern needed (Approval Point #2)
- True blocker (external service, credentials)
- Critical error after 3 retries

**Checkpoint Audit at phase boundaries** (after all P1-XXX, after all P2-XXX, etc.):

```
CHECKPOINT:
[1] READ plan section          [2] GREP tool registrations    [3] LS modules
[4] VR-CONFIG check            [5] VR-TOOL-REG check          [6] VR-HOOK-BUILD check
[7] Pattern scanner            [8] npm run build               [9] cd packages/core && npx tsc --noEmit
[10] npm test                  [11] VR-GENERIC check           [12] Security scanner
[13] COUNT gaps -> IF > 0: FIX and return to [1]
```

---

## Phase 2C: Multi-Perspective Review

After implementation, BEFORE verification loop -- spawn 3 review agents **IN PARALLEL**:

```
security_result = Task(subagent_type="massu-security-reviewer", model="opus", prompt="
  Review implementation for plan: {PLAN_PATH}
  Focus: Security vulnerabilities, auth gaps, input validation, data exposure.
  Return structured result with SECURITY_GATE: PASS/FAIL.
")

architecture_result = Task(subagent_type="massu-architecture-reviewer", model="opus", prompt="
  Review implementation for plan: {PLAN_PATH}
  Focus: Design issues, coupling, pattern compliance, scalability.
  Return structured result with ARCHITECTURE_GATE: PASS/FAIL.
")

quality_result = Task(subagent_type="massu-quality-reviewer", model="sonnet", prompt="
  Review implementation for plan: {PLAN_PATH}
  Focus: Code quality, ESM compliance, config-driven patterns, TypeScript strict mode, test coverage.
  Return structured result with QUALITY_GATE: PASS/FAIL.
")
```

Fix ALL findings at ALL severity levels before proceeding (CR-45). CRITICAL, HIGH, MEDIUM, LOW — all get fixed. No severity is exempt.

---

## Phase 2D: Verification Audit Loop

```
iteration = 0
WHILE true:
  iteration += 1

  # Circuit breaker (CR-37)
  IF iteration >= 3 AND same gaps as previous iteration:
    AskUserQuestion: "Loop stalled after {iteration} passes. Re-plan / Continue / Stop?"

  result = Task(subagent_type="massu-plan-auditor", model="opus", prompt="
    Audit iteration {iteration} for plan: {PLAN_PATH}
    Verify ALL deliverables with VR-* proof.
    Check code quality (patterns, build, types, tests).
    Check plan coverage (every item verified).
    Fix any gaps you find.

    CRITICAL: GAPS_DISCOVERED = total FOUND, even if fixed.
    Finding 5 + fixing 5 = GAPS_DISCOVERED: 5 (NOT 0).
  ")

  gaps = parse GAPS_DISCOVERED from result
  Output: "Verification iteration {iteration}: {gaps} gaps"

  IF gaps == 0: BREAK
  IF iteration >= 10: Report remaining gaps, ask user
END WHILE
```

---

## Phase 2E: Post-Build Reflection + Memory Persist (CR-38)

**MANDATORY -- reflection + memory write = ONE atomic action.**

Answer these questions:
1. "Now that I've built this, what would I have done differently?"
2. "What should be refactored before moving on?"
3. "Did we over-build? Is there a simpler way?"
4. "Would a staff engineer approve this?"

**IMMEDIATELY write ALL learnings to memory/ files** -- failed approaches, new patterns, tool gotchas, architectural insights. DO NOT output reflections as text without writing to memory.

Apply any low-risk refactors immediately. Log remaining suggestions in plan under `## Post-Build Reflection`.

---

## Phase 2F: Documentation Sync (User-Facing Features)

If plan includes ANY user-facing features (new MCP tools, config changes, hook changes):

1. Update relevant documentation (README, API docs, config docs)
2. Ensure tool descriptions match implementation
3. Update config schema documentation if config keys changed

Skip ONLY if purely internal refactoring with zero user-facing changes.

---

## Phase 2G: Browser Verification & Fix Loop

```
[GOLDEN PATH -- PHASE 2G: BROWSER VERIFICATION]
```

**Auto-trigger condition**: If plan touches ANY UI/demo files or produces visual output, this phase runs automatically. If purely backend/MCP/config with zero visual output, skip with log note: `Browser verification: SKIPPED (no UI files changed)`.

### 2G.1 Determine Target Pages

Map changed features to testable URLs:
- If the project has a demo page or documentation site: test affected pages
- If testing MCP tool output: use a test harness or verify tool responses
- Component changes: identify ALL pages that render the component

### 2G.2 Browser Setup & Authentication

Use Playwright MCP plugin tools (`mcp__plugin_playwright_playwright__*`). Fallback: `mcp__playwright__*`.

1. `browser_navigate` to target URL
2. `browser_snapshot` to check page status
3. If authentication required: STOP and request manual login

```
AUTHENTICATION REQUIRED

The Playwright browser is not logged in to the target application.
Please log in manually in the open browser window, then re-run the golden path.
```

**NEVER type credentials. NEVER hardcode passwords. NEVER proceed without authentication.**

### 2G.3 Load Audit (Per Page)

For EACH target page:

| Check | Tool | Captures |
|-------|------|----------|
| Console errors/warnings | `browser_console_messages` | React errors, TypeError, CSP violations |
| Network failures | `browser_network_requests` | 500s, 404s, CORS failures, timeouts |

Categorize findings:

| Category | Severity |
|----------|----------|
| Crash, 500 error, data exposure | **P0 -- CRITICAL** |
| Network failure, broken interaction | **P1 -- HIGH** |
| Visual issues, performance warnings | **P2 -- MEDIUM** |
| Console warnings, deprecations | **P3 -- LOW** |

### 2G.4 Interactive Testing (Per Page)

1. `browser_snapshot` -> inventory ALL interactive elements (buttons, links, forms, selects, tabs, modals, data tables)
2. For EACH testable element:
   - Capture console state BEFORE interaction (`browser_console_messages`)
   - Perform interaction (`browser_click`, `browser_select_option`, `browser_fill_form`)
   - Wait 2-3 seconds for async operations
   - Capture console state AFTER interaction
   - Record any NEW errors introduced
   - `browser_snapshot` to verify DOM state after interaction
   - If interaction opened modal/sheet: test elements inside, then close

**SAFETY**: Never submit forms, click Delete/Send/Submit, or create real records on production.

### 2G.5 Visual & Performance Audit

**Visual checks**:
- Broken images: `browser_evaluate` to find `img` elements with `naturalWidth === 0`
- Layout issues: overflow, overlapping, missing content, broken alignment
- Responsive: `browser_resize` at 1440x900 (desktop), 768x1024 (tablet), 375x812 (mobile)
- Screenshot evidence: `browser_take_screenshot` at each breakpoint if issues found

**Performance checks**:
- Page load timing via `browser_evaluate` (`performance.getEntriesByType('navigation')`)
- Resources > 500KB via `browser_evaluate` (`performance.getEntriesByType('resource')`)
- Slow API calls > 3s, duplicate requests via `browser_network_requests`

| Metric | Good | Needs Work | Critical |
|--------|------|------------|----------|
| DOM Content Loaded | < 2s | 2-5s | > 5s |
| Full Load | < 4s | 4-8s | > 8s |
| TTFB | < 500ms | 500ms-1.5s | > 1.5s |

### 2G.6 Fix Loop

```
issues = ALL findings from 2G.3-2G.5, sorted by priority (P0 first)

FOR EACH issue WHERE priority <= P2:
  1. IDENTIFY root cause (Grep/Read source files)
  2. APPLY fix (follow CLAUDE.md patterns)
  3. VERIFY fix (VR-GREP, VR-NEGATIVE, VR-BUILD, VR-TYPE)
  4. LOG fix in report

Zero-issue standard: ALL P0/P1 fixed, ALL P2 fixed or documented with justification.
Circuit breaker: 5 iterations on same page -> ask user.
```

Post-fix: reload target URLs, re-run load audit + interactive testing for elements that had failures. If new errors appear, add to issues list and continue fix loop.

### 2G.7 Report

Save to `.claude/playwright-reports/{TIMESTAMP}-{SLUG}.md`.

Report includes: summary table, console errors, network failures, interactive element failures, visual issues, performance issues, fix log with files changed and VR checks, unfixed issues with justification, screenshots.

### 2G.8 Auto-Learning Protocol

For EACH browser-discovered fix:
1. Update memory files with symptom/root cause/fix/files
2. Add to `scripts/massu-pattern-scanner.sh` if the bad pattern is grep-able
3. Codebase-wide search for same bad pattern (CR-9) -- fix ALL instances

---

## Subagent Budget Discipline

The golden path spawns multiple subagents across Phase 2. Follow these principles:

| Principle | Meaning |
|-----------|---------|
| **One task per subagent** | Each Task call has a single, scoped objective |
| **Main agent coordinates, subagents execute** | Controller fixes code-level gaps; auditor/reviewer subagents verify |
| **No nested spawns** | Subagents NEVER spawn their own subagents |
| **Parallel only when independent** | 2C review agents run in parallel; 2D audit passes run sequentially |
| **Budget awareness** | Each subagent pass costs ~20-40K tokens. Fix root causes, not symptoms, to minimize iterations |

---

## Phase 2 Complete

```
[GOLDEN PATH -- PHASE 2 COMPLETE]
  All plan items implemented
  Multi-perspective review: PASSED (security, architecture, quality)
  Verification audit: PASSED (Loop #{iteration}, 0 gaps)
  Post-build reflection: PERSISTED to memory
  Documentation sync: COMPLETE / N/A
  Browser verification: PASSED ({N} pages tested, {M} issues fixed) / SKIPPED (no UI files)
```
