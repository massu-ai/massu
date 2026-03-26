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

1. Read plan from disk (NOT memory)
2. Extract ALL deliverables into tracking table:

| Item # | Type | Description | Location | Verification | Status |
|--------|------|-------------|----------|--------------|--------|
| P1-001 | MIGRATION | ... | ... | VR-SCHEMA | PENDING |

3. Create VR-PLAN verification strategy:

| # | VR-* Check | Target | Why Applicable | Status |
|---|-----------|--------|----------------|--------|
| 1 | VR-BUILD | Full project | Always | PENDING |

4. Initialize session state with AUTHORIZED_COMMAND: massu-golden-path

---

## Phase 2A.5: Sprint Contracts

> Full protocol: [sprint-contract-protocol.md](sprint-contract-protocol.md)

**Before implementation begins**, negotiate a sprint contract for each plan item:

1. For each plan item in the tracking table:
   - Define **Scope Boundary** (IN/OUT)
   - Define **Implementation Approach** (files, patterns)
   - Write **3-5 Acceptance Criteria** (must be specific enough that two independent evaluators agree on PASS/FAIL)
   - Map to **VR-\* Verification Types**

2. Add contract columns to the Phase 2A tracking table:

| Item # | Type | Description | Location | Verification | Scope Boundary | Acceptance Criteria | Contract Status |
|--------|------|-------------|----------|--------------|----------------|---------------------|-----------------|
| P1-001 | MIGRATION | ... | ... | VR-SCHEMA | IN: ... / OUT: ... | 1. ... 2. ... 3. ... | AGREED |

3. **Quality bar**: Criteria using words like "good", "correct", "proper" without specifics = reject and rewrite. Each contract must include criteria from at least 3 categories: happy path, data display, empty/loading/error states, user feedback, edge cases.

4. **Skip conditions**: Mark `Contract: N/A` for pure refactors (VR-BUILD + VR-TYPE + VR-TEST sufficient), documentation-only items, and migrations where SQL IS the contract.

5. **Max 3 negotiation rounds** per item. If unresolved, escalate via AskUserQuestion.

---

## Phase 2B: Implementation Loop

For each plan item:
1. **Pre-check**: Load CR rules, domain patterns for the affected file
2. **Execute**: Implement the item following established patterns
3. **Guardrail**: Run `./scripts/pattern-scanner.sh` (ABORT if fails)
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
[1] READ plan section    [2] QUERY DB             [3] GREP routers
[4] LS components        [5] VR-RENDER check      [6] VR-COUPLING check
[7] Pattern scanner      [8] npm run build         [9] npx tsc --noEmit
[10] npm run lint        [11] npx prisma validate  [12] npm test
[13] UI/UX verification  [14] API/router verification  [15] Security check
[16] COUNT gaps -> IF > 0: FIX and return to [1]
```

> **Cross-reference**: Full checkpoint audit protocol with detailed steps is in `massu-loop/references/checkpoint-audit.md`.

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

ux_result = Task(subagent_type="massu-ux-reviewer", model="sonnet", prompt="
  Review implementation for plan: {PLAN_PATH}
  Focus: UX, accessibility, loading/error/empty states, consistency.
  Return structured result with UX_GATE: PASS/FAIL.
")
```

**Phase 2C.2: QA Evaluator** (conditional -- UI plans only)

> Full spec: [qa-evaluator-spec.md](qa-evaluator-spec.md)

If the plan touches UI files, spawn an adversarial QA evaluator:

```
IF plan has UI files:
  qa_result = Task(subagent_type="massu-ux-reviewer", model="opus", prompt="
    === QA EVALUATOR MODE ===
    You are an ADVERSARIAL QA agent. Your job is to FIND BUGS, not approve work.

    Plan: {PLAN_PATH}
    Sprint contracts: {CONTRACTS_FROM_2A5}

    For EACH plan item with a sprint contract:
    1. NAVIGATE to the affected page using Playwright MCP
    2. EXERCISE the feature as a real user would
    3. VERIFY against sprint contract acceptance criteria (EVERY criterion)
    4. CHECK for known failure patterns:
       - Mock/hardcoded data (data doesn't change when DB changes)
       - Write succeeds but read/display broken
       - Feature stubs (onClick/onSubmit empty or log-only)
       - Invisible elements (display:none, opacity:0, z-index buried)
       - Missing query invalidation (create item, verify list updates without refresh)
    5. GRADE: PASS / PARTIAL / FAIL with specific evidence

    ANTI-LENIENCY RULES:
    - Never say 'this is acceptable because...' — if criteria aren't met, it's FAIL
    - Never give benefit of the doubt — if you can't verify it works, it's FAIL
    - Partial credit is still failure — PARTIAL means 'not done yet'
    - Every PASS must cite specific evidence (screenshot, DOM state, network response)

    Return structured result with QA_GATE: PASS/FAIL and per-item grades.
  ")
ELSE:
  Log: "QA Evaluator: SKIPPED (no UI files in plan)"
```

**Gate logic**: Fix ALL CRITICAL/HIGH findings before proceeding. WARN findings = document and proceed.

```
GATES = [SECURITY_GATE, ARCHITECTURE_GATE, UX_GATE]
IF plan has UI files: GATES += [QA_GATE]
IF ANY gate == FAIL: Fix findings and re-run failed gates
ALL gates must PASS before proceeding to Phase 2D.
```

---

## Phase 2D: Verification Audit Loop

```
iteration = 0
WHILE true:
  iteration += 1

  # Circuit breaker (detect stagnation)
  IF iteration >= 3:
    stalled_items = items that failed in ALL of last 3 iterations
    IF stalled_items.length > 0:
      Log: "REFINE-OR-PIVOT: {stalled_items.length} items stalled for 3+ iterations"
      FOR EACH stalled_item:
        IF same_root_cause_each_time: REFINE (targeted fix for root cause)
        IF different_failures_each_time: PIVOT (scrap approach, try alternative)
        IF no_clear_pattern: AskUserQuestion with evidence from last 3 attempts

  result = Task(subagent_type="massu-plan-auditor", model="opus", prompt="
    Audit iteration {iteration} for plan: {PLAN_PATH}
    Verify ALL deliverables with VR-* proof.
    Check code quality (patterns, build, types, tests).
    Check plan coverage (every item verified).

    VR-SPEC-MATCH: For EVERY UI plan item with specific CSS classes,
    component names, or layout instructions -- grep the implementation for those
    EXACT strings. Missing = gap.

    VR-PIPELINE: For features with data pipelines (AI, cron, generation),
    trigger the pipeline procedure and verify output is non-empty. Empty = gap.

    SPRINT CONTRACT VERIFICATION: For each plan item with a sprint contract
    (from Phase 2A.5), verify EVERY acceptance criterion is met:
    - Read the contract's acceptance criteria list
    - Test each criterion with specific evidence (screenshot, grep, DOM state)
    - Any unmet criterion = gap, even if the code 'looks right'
    - Contract criteria are IN ADDITION TO VR-* checks — both must pass

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

## Phase 2E: Post-Build Reflection + Memory Persist

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

If plan includes ANY user-facing features:

1. Audit documentation against code changes
2. Update affected documentation pages
3. Add changelog entry
4. Commit documentation updates (separate repo if applicable)

Skip ONLY if purely backend/infra with zero user-facing changes.

---

## Phase 2G: Browser Verification & Fix Loop

```
[GOLDEN PATH -- PHASE 2G: BROWSER VERIFICATION]
```

**Auto-trigger condition**: If plan touches ANY UI files, this phase runs automatically. If purely backend/infra with zero UI changes, skip with log note: `Browser verification: SKIPPED (no UI files changed)`.

**SAFETY RULE**: NEVER use real client data. NEVER click destructive actions (Delete, Send, Submit) on production.

### 2G.1 Determine Target Pages

Map changed files to URLs:
- Component changes: identify ALL pages that render the component
- Layout changes: test ALL child routes under that layout

### 2G.2 Browser Setup & Authentication

Use Playwright MCP plugin tools.

1. `browser_navigate` to first target URL
2. `browser_snapshot` to check auth status
3. If redirected to `/login` or auth check visible: STOP and request manual login

```
AUTHENTICATION REQUIRED

The Playwright browser is not logged in to the app.
Please log in manually in the open browser window, then re-run the golden path.
```

**NEVER type credentials. NEVER hardcode passwords. NEVER proceed without authentication.**

### 2G.3 Load Audit (Per Page)

For EACH target page:

| Check | Tool | Captures |
|-------|------|----------|
| Console errors/warnings | `browser_console_messages` | React errors, TypeError, CSP violations, auth warnings |
| Network failures | `browser_network_requests` | 500s, 404s, CORS failures, timeouts |

Categorize findings:

| Category | Severity |
|----------|----------|
| React crash, 500 error, data exposure | **P0 -- CRITICAL** |
| Network failure, CSP violation, broken interaction, auth warning | **P1 -- HIGH** |
| Visual issues, performance warnings, broken images | **P2 -- MEDIUM** |
| Console warnings, deprecations, i18n missing keys | **P3 -- LOW** |

### 2G.4 Interactive Testing (Per Page)

1. `browser_snapshot` -> inventory ALL interactive elements
2. For EACH testable element:
   - Capture console state BEFORE interaction
   - Perform interaction
   - Wait 2-3 seconds for async operations
   - Capture console state AFTER interaction
   - Record any NEW errors introduced
   - `browser_snapshot` to verify DOM state after interaction
   - If interaction opened modal/sheet: test elements inside, then close

**SAFETY**: Never submit forms, click Delete/Send/Submit, or create real records on production.

### 2G.5 Visual & Performance Audit

**Visual checks**:
- Broken images: find `img` elements with `naturalWidth === 0`
- Layout issues: overflow, overlapping, missing content, broken alignment
- Responsive: test at 1440x900 (desktop), 768x1024 (tablet), 375x812 (mobile)
- Screenshot evidence at each breakpoint if issues found

**Performance checks**:
- Page load timing
- Resources > 500KB
- Slow API calls > 3s, duplicate requests

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
1. Record with type="bugfix" including browser symptom -> code fix mapping
2. Update MEMORY.md with symptom/root cause/fix/files
3. Add to `scripts/pattern-scanner.sh` if the bad pattern is grep-able
4. Codebase-wide search for same bad pattern (CR-9) -- fix ALL instances

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
  Sprint contracts: NEGOTIATED ({N} items contracted, {M} N/A)
  All plan items implemented
  Multi-perspective review: PASSED (security, architecture, UX)
  QA evaluator: PASSED / SKIPPED (no UI files)
  Verification audit: PASSED (Loop #{iteration}, 0 gaps, contracts verified)
  Post-build reflection: PERSISTED to memory
  Documentation sync: COMPLETE / N/A
  Browser verification: PASSED ({N} pages tested, {M} issues fixed) / SKIPPED (no UI files)
```
