---
name: massu-golden-path
description: Complete end-to-end workflow from requirements to production push with minimal pause points
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), Task(*), mcp__plugin_playwright_playwright__*, mcp__playwright__*
---
name: massu-golden-path

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Massu Golden Path: Requirements to Production Push

## Objective

Execute the COMPLETE development workflow in one continuous run:
**Requirements --> Plan Creation --> Plan Audit --> Implementation --> Browser Verification --> Simplification --> Commit --> Push**

This command has FULL FEATURE PARITY with the individual commands it replaces:
`/massu-create-plan` --> `/massu-plan` --> `/massu-loop` --> `/massu-loop-playwright` --> `/massu-simplify` --> `/massu-commit` --> `/massu-push`

---

## NON-NEGOTIABLE RULES

- **Complete workflow** -- ALL phases must execute, no skipping
- **Zero failures** -- Each phase gate must pass before proceeding
- **Proof required** -- Show output of each phase gate
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** -- Whether from current changes or pre-existing
- **MEMORY IS MANDATORY (CR-38)** -- Persist ALL learnings before session ends

---

## APPROVAL POINTS (Max 4 Pauses)

```
+-----------------------------------------------------------------------------+
|   THIS COMMAND RUNS STRAIGHT THROUGH THE ENTIRE GOLDEN PATH.                |
|   IT ONLY PAUSES FOR THESE APPROVAL POINTS:                                |
|                                                                             |
|   1. PLAN APPROVAL - After plan creation + audit (user reviews plan)        |
|   2. NEW PATTERN APPROVAL - If a new pattern is needed (during any phase)   |
|   3. COMMIT APPROVAL - Before creating the commit                           |
|   4. PUSH APPROVAL - Before pushing to remote                               |
|                                                                             |
|   EVERYTHING ELSE RUNS AUTOMATICALLY WITHOUT STOPPING.                      |
+-----------------------------------------------------------------------------+
```

### Approval Point Format

```
===============================================================================
APPROVAL REQUIRED: [TYPE]
===============================================================================

[Details]

OPTIONS:
  - "approve" / "yes" to continue
  - "modify" to request changes
  - "abort" to stop the golden path

===============================================================================
```

After receiving approval, immediately continue. Do NOT ask "shall I continue?" -- just proceed.

---

## INPUT MODES

| Mode | Input | Behavior |
|------|-------|----------|
| **Task Description** | `/massu-golden-path "Implement feature X"` | Full flow from Phase 0 |
| **Plan File** | `/massu-golden-path /path/to/plan.md` | Skip to Phase 1C (audit) |
| **Continue** | `/massu-golden-path "Continue [feature]"` | Resume from session state |

---

## PHASE 0: REQUIREMENTS & CONTEXT LOADING

### 0.1 Session Context Loading

```
[GOLDEN PATH -- PHASE 0: REQUIREMENTS & CONTEXT]
```

- Read `session-state/CURRENT.md` for any prior state
- Read `massu.config.yaml` for project configuration
- Search memory files for relevant prior context

### 0.2 Requirements Coverage Map

Initialize ALL dimensions as `pending`:

| # | Dimension | Status | Resolved By |
|---|-----------|--------|-------------|
| D1 | Problem & Scope | pending | User request + interview |
| D2 | Users & Personas | pending | Interview |
| D3 | Data Model | pending | Phase 1A (Config/Schema Reality Check) |
| D4 | Backend / API | pending | Phase 1A (Codebase Reality Check) |
| D5 | Frontend / UX | pending | Interview + Phase 1A |
| D6 | Auth & Permissions | pending | Phase 1A (Security Pre-Screen) |
| D7 | Error Handling | pending | Phase 1A (Pattern Compliance) |
| D8 | Security | pending | Phase 1A (Security Pre-Screen) |
| D9 | Edge Cases | pending | Phase 1A (Question Filtering) |
| D10 | Performance | pending | Phase 1A (Pattern Compliance) |

### 0.3 Ambiguity Detection (7 Signals)

| Signal | Description |
|--------|-------------|
| A1 | Vague scope -- no clear boundary |
| A2 | No success criteria -- no measurable outcome |
| A3 | Implicit requirements -- unstated but necessary |
| A4 | Multi-domain -- spans 3+ domains |
| A5 | Contradictions -- conflicting constraints |
| A6 | No persona -- unclear who benefits |
| A7 | New integration -- external service not yet in codebase |

**Score >= 2**: Enter interview loop (0.4). **Score 0-1**: Fast-track to Phase 1A.

### 0.4 Interview Loop (When Triggered)

Ask via AskUserQuestion, one question at a time:
1. Show compact coverage status: `Coverage: D1:done D2:pending ...`
2. Provide 2-4 curated options (never open-ended)
3. Push back on contradictions and over-engineering
4. Self-terminate when D1, D2, D5 covered
5. Escape hatch: user says "skip" / "enough" / "just do it" --> mark remaining as `n/a`

---

## PHASE 1: PLAN CREATION & AUDIT

### Phase 1A: Research & Reality Check

```
[GOLDEN PATH -- PHASE 1A: RESEARCH & REALITY CHECK]
```

**If plan file was provided**: Skip to Phase 1C.

#### 1A.1 Feature Understanding

- Document: exact user request, feature type, affected domains
- Search codebase for similar features, tool modules, existing patterns
- Read `massu.config.yaml` for relevant config sections

#### 1A.2 Config & Schema Reality Check

For features touching config or databases:

- Parse `massu.config.yaml` and verify all referenced config keys exist
- Check SQLite schema for affected tables (`getCodeGraphDb`, `getDataDb`, `getMemoryDb`)
- Verify tool definitions in `tools.ts` for any tools being modified

Document: existing config keys, required new keys, required schema changes.

#### 1A.3 Config-Code Alignment (VR-CONFIG)

If feature uses config-driven values:

```bash
# Check config keys used in code
grep -rn "getConfig()" packages/core/src/ | grep -oP 'config\.\w+' | sort -u
# Compare to massu.config.yaml structure
```

#### 1A.4 Codebase Reality Check

- Verify target directories/files exist
- Read similar tool modules and handlers
- Load relevant pattern files (build/testing/security/database/mcp)

#### 1A.5 Blast Radius Analysis (CR-10)

**MANDATORY when plan changes any constant, export name, config key, or tool name.**

1. Identify ALL changed values (old --> new)
2. Codebase-wide grep for EACH value
3. If plan deletes files: verify no remaining imports or references
4. Categorize EVERY occurrence: CHANGE / KEEP (with reason) / INVESTIGATE
5. Resolve ALL INVESTIGATE to 0. Add ALL CHANGE items as plan deliverables.

#### 1A.6 Pattern Compliance Check

Check applicable patterns: ESM imports (.ts extensions), config access (getConfig()), tool registration (3-function pattern), hook compilation (esbuild), SQLite DB access (getCodeGraphDb/getDataDb/getMemoryDb), memDb lifecycle (try/finally close).

Read most similar tool module for patterns used.

#### 1A.7 Tool Registration Check (CR-11)

For EVERY new MCP tool planned -- verify a corresponding registration item exists in the plan (definitions + routing + handler in `tools.ts`). If NOT, ADD IT.

#### 1A.8 Question Filtering

1. List all open questions
2. Self-answer anything answerable by reading code or config
3. Surface only business logic / UX / scope / priority questions to user via AskUserQuestion
4. If all self-answerable, skip user prompt

#### 1A.9 Security Pre-Screen (5 Dimensions)

| Dim | Check | If Triggered |
|-----|-------|-------------|
| S1 | PII / Sensitive Data | Add access controls |
| S2 | Authentication | Verify auth checks |
| S3 | Authorization | Add permission checks |
| S4 | Injection Surfaces | Add input validation, parameterized queries |
| S5 | Rate Limiting | Add rate limiting considerations |

**BLOCKS_REMAINING must = 0 before proceeding.**

Mark all coverage dimensions as `done` or `n/a`.

### Phase 1B: Plan Generation

```
[GOLDEN PATH -- PHASE 1B: PLAN GENERATION]
```

Write plan to: `docs/plans/[YYYY-MM-DD]-[feature-name].md`

**Plan structure** (P-XXX numbered items):
- Overview (feature, complexity, domains, item count)
- Requirements Coverage Map (D1-D10 all resolved)
- Phase 1: Configuration Changes (massu.config.yaml)
- Phase 2: Backend Implementation (tool modules, handlers, SQLite schema)
- Phase 3: Frontend/Hook Implementation (hooks, plugin code)
- Phase 4: Testing & Verification
- Phase 5: Documentation
- Verification Commands table
- Item Summary table
- Risk Assessment
- Dependencies

**Item numbering**: P1-XXX (config), P2-XXX (backend), P3-XXX (frontend/hooks), P4-XXX (testing), P5-XXX (docs).

**Implementation Specificity Check**: Every item MUST have exact file path, exact content, insertion point, format matches target, verification command.

### Phase 1C: Plan Audit Loop

```
[GOLDEN PATH -- PHASE 1C: PLAN AUDIT LOOP]
```

Run audit loop using subagent architecture (prevents early termination):

```
iteration = 0
WHILE true:
  iteration += 1

  result = Task(subagent_type="massu-plan-auditor", model="opus", prompt="
    Audit iteration {iteration} for plan: {PLAN_PATH}
    Execute ONE complete audit pass. Verify ALL deliverables.
    Check: VR-PLAN-FEASIBILITY, VR-PLAN-SPECIFICITY, Pattern Alignment, Config Reality.
    Fix any plan document gaps you find.

    CRITICAL: Report GAPS_DISCOVERED as total gaps FOUND, EVEN IF you fixed them.
    Finding N gaps and fixing all N = GAPS_DISCOVERED: N.
    A clean pass finding nothing = GAPS_DISCOVERED: 0.
  ")

  gaps = parse GAPS_DISCOVERED from result
  IF gaps == 0: BREAK (clean pass)
  ELSE: CONTINUE (re-audit)

  IF iteration >= 10: Report to user, ask how to proceed
END WHILE
```

**VR-PLAN-FEASIBILITY**: Files exist, config keys valid, dependencies available, patterns documented.
**VR-PLAN-SPECIFICITY**: Every item has exact path, exact content, insertion point, verification command.
**Pattern Alignment**: Cross-reference ALL applicable patterns from CLAUDE.md and patterns/*.md.

### Phase 1 Complete --> APPROVAL POINT #1: PLAN

```
===============================================================================
APPROVAL REQUIRED: PLAN
===============================================================================

Plan created and audited ({iteration} audit passes, 0 gaps).

PLAN SUMMARY:
-------------------------------------------------------------------------------
Feature: [name]
File: [plan path]
Total Items: [N]
Phases: [list]

Requirements Coverage: [X]/10 dimensions resolved
Feasibility: VERIFIED (config, files, patterns, security)
Audit Passes: {iteration} (final pass: 0 gaps)
-------------------------------------------------------------------------------

OPTIONS:
  - "approve" to begin implementation
  - "modify: [changes]" to adjust plan
  - "abort" to stop

===============================================================================
```

---

## PHASE 2: IMPLEMENTATION

### Phase 2A: Plan Item Extraction & Setup

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

### Phase 2B: Implementation Loop

For each plan item:
1. **Pre-check**: Verify file exists, read current state
2. **Execute**: Implement the item following established patterns
3. **Guardrail**: Run `bash scripts/massu-pattern-scanner.sh` (ABORT if fails)
4. **Verify**: Run applicable VR-* checks with proof
5. **Update**: Mark item complete in tracking table

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
[13] COUNT gaps --> IF > 0: FIX and return to [1]
```

### Phase 2C: Multi-Perspective Review

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

Fix ALL CRITICAL/HIGH findings before proceeding. WARN findings = document and proceed.

### Phase 2D: Verification Audit Loop

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

### Phase 2E: Post-Build Reflection + Memory Persist (CR-38)

**MANDATORY -- reflection + memory write = ONE atomic action.**

Answer these questions:
1. "Now that I've built this, what would I have done differently?"
2. "What should be refactored before moving on?"
3. "Did we over-build? Is there a simpler way?"
4. "Would a staff engineer approve this?" (Core Principle #9)

**IMMEDIATELY write ALL learnings to memory/ files** -- failed approaches, new patterns, tool gotchas, architectural insights. DO NOT output reflections as text without writing to memory.

Apply any low-risk refactors immediately. Log remaining suggestions in plan under `## Post-Build Reflection`.

### Phase 2F: Documentation Sync (User-Facing Features)

If plan includes ANY user-facing features (new MCP tools, config changes, hook changes):

1. Update relevant documentation (README, API docs, config docs)
2. Ensure tool descriptions match implementation
3. Update config schema documentation if config keys changed

Skip ONLY if purely internal refactoring with zero user-facing changes.

### Phase 2G: Browser Verification & Fix Loop (`/massu-loop-playwright`)

```
[GOLDEN PATH -- PHASE 2G: BROWSER VERIFICATION]
```

**This phase executes the full `/massu-loop-playwright` protocol inline.** See `massu-loop-playwright.md` for the standalone version.

**Auto-trigger condition**: If plan touches ANY UI/demo files or produces visual output, this phase runs automatically. If purely backend/MCP/config with zero visual output, skip with log note: `Browser verification: SKIPPED (no UI files changed)`.

#### 2G.1 Determine Target Pages

Map changed features to testable URLs:
- If Massu has a demo page or documentation site: test affected pages
- If testing MCP tool output: use a test harness or verify tool responses
- Component changes: identify ALL pages that render the component

#### 2G.2 Browser Setup & Authentication

Use Playwright MCP plugin tools (`mcp__plugin_playwright_playwright__*`). Fallback: `mcp__playwright__*`.

1. `browser_navigate` to target URL ($TARGET_URL)
2. `browser_snapshot` to check page status
3. If authentication required: STOP and request manual login

```
AUTHENTICATION REQUIRED

The Playwright browser is not logged in to the target application.
Please log in manually in the open browser window, then re-run the golden path.
```

**NEVER type credentials. NEVER hardcode passwords. NEVER proceed without authentication.**

#### 2G.3 Load Audit (Per Page)

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

#### 2G.4 Interactive Testing (Per Page)

1. `browser_snapshot` --> inventory ALL interactive elements (buttons, links, forms, selects, tabs, modals, data tables)
2. For EACH testable element:
   - Capture console state BEFORE interaction (`browser_console_messages`)
   - Perform interaction (`browser_click`, `browser_select_option`, `browser_fill_form`)
   - Wait 2-3 seconds for async operations
   - Capture console state AFTER interaction
   - Record any NEW errors introduced
   - `browser_snapshot` to verify DOM state after interaction
   - If interaction opened modal/sheet: test elements inside, then close

**SAFETY**: Never submit forms, click Delete/Send/Submit, or create real records on production.

#### 2G.5 Visual & Performance Audit

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

#### 2G.6 Fix Loop

```
issues = ALL findings from 2G.3-2G.5, sorted by priority (P0 first)

FOR EACH issue WHERE priority <= P2:
  1. IDENTIFY root cause (Grep/Read source files)
  2. APPLY fix (follow CLAUDE.md patterns)
  3. VERIFY fix (VR-GREP, VR-NEGATIVE, VR-BUILD, VR-TYPE)
  4. LOG fix in report

Zero-issue standard: ALL P0/P1 fixed, ALL P2 fixed or documented with justification.
Circuit breaker: 5 iterations on same page --> ask user.
```

Post-fix: reload target URLs, re-run load audit + interactive testing for elements that had failures. If new errors appear, add to issues list and continue fix loop.

#### 2G.7 Report

Save to `.claude/playwright-reports/{TIMESTAMP}-{SLUG}.md`.

Report includes: summary table, console errors, network failures, interactive element failures, visual issues, performance issues, fix log with files changed and VR checks, unfixed issues with justification, screenshots.

#### 2G.8 Auto-Learning Protocol

For EACH browser-discovered fix:
1. Update memory files with symptom/root cause/fix/files
2. Add to `scripts/massu-pattern-scanner.sh` if the bad pattern is grep-able
3. Codebase-wide search for same bad pattern (CR-9) -- fix ALL instances

```
[GOLDEN PATH -- PHASE 2 COMPLETE]
- All plan items implemented
- Multi-perspective review: PASSED (security, architecture, quality)
- Verification audit: PASSED (Loop #{iteration}, 0 gaps)
- Post-build reflection: PERSISTED to memory
- Documentation sync: COMPLETE / N/A
- Browser verification: PASSED ({N} pages tested, {M} issues fixed) / SKIPPED (no UI files)
```

---

## PHASE 3: SIMPLIFICATION (`/massu-simplify`)

```
[GOLDEN PATH -- PHASE 3: SIMPLIFICATION]
```

**This phase executes the full `/massu-simplify` protocol inline.** See `massu-simplify.md` for the standalone version.

### 3.1 Fast Gate

```bash
bash scripts/massu-pattern-scanner.sh  # Fix ALL violations before semantic analysis
```

### 3.2 Parallel Semantic Review (3 Agents)

Spawn IN PARALLEL (Core Principle #10 -- one task per agent):

**Efficiency Reviewer** (haiku): Query inefficiency (findMany equivalent vs SQL COUNT, N+1 queries, unbounded queries), algorithmic inefficiency (O(n^2), repeated sort/filter), unnecessary allocations, missing caching opportunities.

**Reuse Reviewer** (haiku): Known utilities (getConfig(), stripPrefix(), tool registration patterns, memDb lifecycle pattern), module duplication against existing tool modules, pattern duplication across new files, config values that should be in massu.config.yaml.

**Pattern Compliance Reviewer** (haiku): ESM compliance (.ts import extensions, no require()), config-driven patterns (no hardcoded project-specific values -- CR-38/VR-GENERIC), TypeScript strict mode compliance, tool registration (3-function pattern preferred -- CR-11), hook compilation (esbuild compatible -- CR-12), memDb lifecycle (try/finally close), security (input validation, no eval/exec).

### 3.3 Apply ALL Findings

Sort by SEVERITY (CRITICAL --> LOW). Fix ALL (CR-9). Re-run pattern scanner.

```
SIMPLIFY_GATE: PASS (N findings, N fixed, 0 remaining)
```

---

## PHASE 4: PRE-COMMIT VERIFICATION

```
[GOLDEN PATH -- PHASE 4: PRE-COMMIT VERIFICATION]
```

### 4.1 Auto-Verification Gates (ALL must pass in SINGLE run)

| Gate | Command | Expected |
|------|---------|----------|
| 1. Pattern Scanner | `bash scripts/massu-pattern-scanner.sh` | Exit 0 |
| 2. Type Safety (VR-TYPE) | `cd packages/core && npx tsc --noEmit` | 0 errors |
| 3. Build (VR-BUILD) | `npm run build` | Exit 0 |
| 4. Tests (VR-TEST) | `npm test` | ALL pass |
| 5. Hook Compilation (VR-HOOK-BUILD) | `cd packages/core && npm run build:hooks` | Exit 0 |
| 6. Generalization (VR-GENERIC) | `bash scripts/massu-generalization-scanner.sh` | Exit 0 |
| 7. Security Scanner | `bash scripts/massu-security-scanner.sh` | Exit 0 |
| 8. Secrets Staged | `git diff --cached --name-only \| grep -E '\.(env\|pem\|key\|secret)'` | 0 files |
| 9. Credentials in Code | `grep -rn "sk-\|password.*=.*['\"]" --include="*.ts" packages/ \| grep -v "process.env" \| wc -l` | 0 |
| 10. VR-TOOL-REG | For EACH new tool: verify definitions + handler wired in tools.ts | All wired |
| 11. Plan Coverage | Verify ALL plan items with VR-* proof | 100% |
| 12. VR-PLAN-STATUS | `grep "IMPLEMENTATION STATUS" [plan]` | Match |
| 13. Dependency Security | `npm audit --audit-level=high` | 0 high/crit |

### 4.2 Quality Scoring Gate

Spawn `massu-output-scorer` (sonnet): Code Clarity, Pattern Compliance, Error Handling, Test Coverage, Config-Driven Design (1-5 each). All >= 3: PASS. Any < 3: FAIL.

### 4.3 If ANY Gate Fails

**DO NOT PAUSE** -- Fix automatically, re-run ALL gates, repeat until all pass.

### 4.4 Auto-Learning Protocol

- For each bug fixed: update memory files
- For new patterns: record in memory
- Add detection to `scripts/massu-pattern-scanner.sh` if grep-able
- Codebase-wide search: no other instances of same bad pattern (CR-9)
- Record user corrections to `memory/corrections.md`

### Phase 4 Complete --> APPROVAL POINT #3: COMMIT

```
===============================================================================
APPROVAL REQUIRED: COMMIT
===============================================================================

All verification checks passed. Ready to commit.

VERIFICATION RESULTS:
-------------------------------------------------------------------------------
- Pattern scanner: Exit 0
- Type check: 0 errors
- Build: Exit 0
- Tests: ALL pass
- Hook compilation: Exit 0
- Generalization: Exit 0
- Security: No secrets staged, no credentials in code
- Tool registration: All new tools wired
- Plan Coverage: [X]/[X] = 100%
- Quality Score: [X.X]/5.0
-------------------------------------------------------------------------------

FILES TO BE COMMITTED:
[list]

PROPOSED COMMIT MESSAGE:
-------------------------------------------------------------------------------
[type]: [description]

[body]

Co-Authored-By: Claude <noreply@anthropic.com>
-------------------------------------------------------------------------------

OPTIONS:
  - "approve" to commit and continue to push
  - "message: [new message]" to change commit message
  - "abort" to stop (changes remain staged)

===============================================================================
```

### Commit Format

```bash
git commit -m "$(cat <<'EOF'
[type]: [description]

[Body]

Changes:
- [Change 1]
- [Change 2]

Verified:
- Pattern scanner: PASS | Type check: 0 errors | Build: PASS
- Tests: ALL pass | Hooks: compiled | Generalization: PASS

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## PHASE 5: PUSH VERIFICATION & PUSH

```
[GOLDEN PATH -- PHASE 5: PUSH VERIFICATION]
```

### 5.1 Pre-Flight

```bash
git log origin/main..HEAD --oneline  # Commits to push
```

### 5.2 Tier 1: Quick Re-Verification

Run in parallel where possible:

| Check | Command |
|-------|---------|
| Pattern Scanner | `bash scripts/massu-pattern-scanner.sh` |
| Generalization | `bash scripts/massu-generalization-scanner.sh` |
| TypeScript | `cd packages/core && npx tsc --noEmit` |
| Build | `npm run build` |
| Hook Compilation | `cd packages/core && npm run build:hooks` |

### 5.3 Tier 2: Test Suite (CRITICAL)

#### 5.3.0 Regression Detection (MANDATORY FIRST)

```bash
# Establish baseline on main
git stash && git checkout main -q
npm test 2>&1 | tee /tmp/baseline-tests.txt
git checkout - -q && git stash pop -q

# Run on current branch
npm test 2>&1 | tee /tmp/current-tests.txt

# Compare: any test passing on main but failing now = REGRESSION
# Regressions MUST be fixed before push
```

#### 5.3.1-5.3.3 Test Execution

Use **parallel Task agents** for independent checks:

```
Agent Group A (parallel):
- Agent 1: npm test (unit tests)
- Agent 2: npm audit --audit-level=high
- Agent 3: bash scripts/massu-security-scanner.sh

Sequential:
- VR-TOOL-REG: verify ALL new tools registered in tools.ts
- VR-GENERIC: verify ALL files pass generalization scanner
```

### 5.4 Tier 3: Security & Compliance

| Check | Command |
|-------|---------|
| npm audit | `npm audit --audit-level=high` |
| Security scan | `bash scripts/massu-security-scanner.sh` |
| Config validation | Parse massu.config.yaml without errors |

### 5.5 Tier 4: Final Gate

All tiers must pass:

| Tier | Status |
|------|--------|
| Tier 1: Quick Checks | PASS/FAIL |
| Tier 2: Test Suite + Regression | PASS/FAIL |
| Tier 3: Security & Compliance | PASS/FAIL |

### Phase 5 Gate --> APPROVAL POINT #4: PUSH

```
===============================================================================
APPROVAL REQUIRED: PUSH TO REMOTE
===============================================================================

All verification tiers passed. Ready to push.

PUSH GATE SUMMARY:
-------------------------------------------------------------------------------
Commit: [hash]
Message: [message]
Files changed: [N] | +[N] / -[N]
Branch: [branch] --> origin

Tier 1 (Quick): PASS
Tier 2 (Tests): PASS -- Unit: X/X, Regression: 0
Tier 3 (Security): PASS -- Audit: 0 high/crit, Secrets: clean
-------------------------------------------------------------------------------

OPTIONS:
  - "approve" / "push" to push to remote
  - "abort" to stop (commit remains local)

===============================================================================
```

After approval: `git push origin [branch]`, then verify with `gh run list --limit 3`.

---

## PHASE 6: COMPLETION

### 6.1 Final Report

```
===============================================================================
GOLDEN PATH COMPLETE
===============================================================================

SUMMARY:
-------------------------------------------------------------------------------
Phase 0: Requirements & Context    - D1-D10 resolved
Phase 1: Plan Creation & Audit     - [N] items, [M] audit passes
Phase 2: Implementation            - [N] audit loops, 3 reviewers passed
Phase 2G: Browser Verification     - [N] pages tested, [M] issues fixed / SKIPPED
Phase 3: Simplification            - [N] findings fixed
Phase 4: Pre-Commit Verification   - All gates passed
Phase 5: Push Verification         - 3 tiers passed, 0 regressions
-------------------------------------------------------------------------------

DELIVERABLES:
  - Plan: [plan path]
  - Commit: [hash]
  - Branch: [branch]
  - Pushed: YES
  - Files changed: [N]

===============================================================================
```

### 6.2 Plan Document Update (MANDATORY)

Add to TOP of plan document:

```markdown
# IMPLEMENTATION STATUS

**Plan**: [Name]
**Status**: COMPLETE -- PUSHED
**Last Updated**: [YYYY-MM-DD HH:MM]
**Push Commit**: [hash]
**Completed By**: Claude Code (Massu Golden Path)

## Task Completion Summary
| # | Task/Phase | Status | Verification | Date |
|---|------------|--------|--------------|------|
| 1 | [description] | 100% COMPLETE | VR-BUILD: Pass | [date] |
```

### 6.3 Auto-Learning Protocol (MANDATORY)

1. Review ALL fixes: `git diff origin/main..HEAD`
2. For each fix: verify memory files updated
3. For each new pattern: verify recorded
4. For each failed approach: verify recorded
5. Record user corrections to `memory/corrections.md`
6. Consider new CR rule if a class of bug was found

### 6.4 Update Session State

Update `session-state/CURRENT.md` with completion status.

---

## NEW PATTERN APPROVAL (APPROVAL POINT #2 -- Any Phase)

If a new pattern is needed during ANY phase:

```
===============================================================================
APPROVAL REQUIRED: NEW PATTERN
===============================================================================

A new pattern is needed for: [functionality]

Existing patterns checked:
- [pattern 1]: Not suitable because [reason]

PROPOSED NEW PATTERN:
-------------------------------------------------------------------------------
Name: [Pattern Name]
Domain: [Config/MCP/Hook/etc.]

WRONG: ```[code]```
CORRECT: ```[code]```
Error if violated: [What breaks]
-------------------------------------------------------------------------------

OPTIONS:
  - "approve" to save and continue
  - "modify: [changes]" to adjust
  - "abort" to stop

===============================================================================
```

---

## ABORT HANDLING

```
===============================================================================
GOLDEN PATH ABORTED
===============================================================================

Stopped at: [Phase N -- Approval Point]

CURRENT STATE:
  - Completed phases: [list]
  - Pending phases: [list]
  - Plan file: [path]
  - Files changed: [list]
  - Commit created: YES/NO
  - Pushed: NO

TO RESUME:
  Run /massu-golden-path again with the same plan
  Or run individual commands:
    /massu-loop      -- Continue implementation
    /massu-commit    -- Run commit verification
    /massu-push      -- Run push verification

===============================================================================
```

---

## ERROR HANDLING

**Recoverable**: Fix automatically --> re-run failed step --> if fixed, continue without pausing --> if not fixable after 3 attempts, pause and report.

**Non-Recoverable**:
```
===============================================================================
GOLDEN PATH BLOCKED
===============================================================================

BLOCKER: [Description]
Required: [Steps to resolve]
After resolving, run /massu-golden-path again.

===============================================================================
```

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state (CR-35)**

Update `session-state/CURRENT.md`:
```
AUTHORIZED_COMMAND: massu-golden-path
```

1. **Determine input**: Task description, plan file, or continue
2. **Phase 0**: Requirements & context (if task description)
3. **Phase 1**: Plan creation & audit --> **PAUSE: Plan Approval**
4. **Phase 2**: Implementation with verification loops + browser verification (UI changes)
5. **Phase 3**: Simplification (efficiency, reuse, patterns)
6. **Phase 4**: Pre-commit verification --> **PAUSE: Commit Approval**
7. **Phase 5**: Push verification --> **PAUSE: Push Approval**
8. **Phase 6**: Completion, learning, quality metrics

**This command does NOT stop to ask "should I continue?" -- it runs straight through.**
