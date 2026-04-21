---
name: massu-plan
description: "When user wants to audit an existing plan for gaps -- 'audit this plan', 'review the plan', or references a plan file that needs verification"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), Task(*)
---
name: massu-plan

# Massu Plan: Continuous Verification Audit Loop (ZERO-GAP STANDARD)

**Shared rules**: Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-12 enforced.

> **Config lookup (framework-aware)**: This command reads `config.framework.type` and `config.verification.<primary_language>` from `massu.config.yaml` to choose the right verification commands. Hardcoded references below to `packages/core`, `tools.ts`, `vitest`, `VR-TOOL-REG`, and `VR-HOOK-BUILD` are **MCP-project specific** and only apply when `config.framework.type === 'mcp'` (or `languages.typescript.runtime === 'mcp'`). For other projects, substitute: type-check → `config.verification.<primary_language>.type`, tests → `.test`, build → `.build`, lint → `.lint`. See `.claude/reference/vr-verification-reference.md` for the config-driven VR-* catalog.

---

## Workflow Position

```
/massu-create-plan -> /massu-plan -> /massu-loop -> /massu-commit -> /massu-push
(CREATE)           (AUDIT)        (IMPLEMENT)   (COMMIT)        (PUSH)
```

**This command is step 2 of 5 in the standard workflow.**

---

## THIS IS A PLAN-AUDIT COMMAND, NOT AN IMPLEMENTATION COMMAND

**THIS COMMAND AUDITS AND IMPROVES PLAN DOCUMENTS. IT DOES NOT IMPLEMENT CODE.**

### FORBIDDEN Actions
- Writing code to source files (Edit/Write to packages/)
- Creating modules, tools, or hooks
- Making database changes
- Implementing any plan items

### ALLOWED Actions
- Research to verify plan feasibility (Read, Grep, Glob)
- Edit the PLAN DOCUMENT to fix gaps (Write/Edit to docs/plans/)
- Loop until plan has zero gaps
- Present completed plan to user
- **STOP AND WAIT** for explicit user approval

### AFTER AUDIT COMPLETE: MANDATORY WAIT
1. **Present the plan** to the user
2. **STOP completely** - Do not start implementation
3. **WAIT** for explicit user instruction (e.g., "run /massu-loop")

| Command | Purpose | Edits Source Code? |
|---------|---------|-------------------|
| `/massu-create-plan` | Create plan document | **NO** |
| `/massu-plan` | Audit/improve plan document | **NO** |
| `/massu-loop` | Implement plan with verification | **YES** |

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state (CR-12)**

Update `session-state/CURRENT.md` to include `AUTHORIZED_COMMAND: massu-plan`.

**Step 0.1: Workflow State Tracking**

Write a transition entry to `.massu/workflow-log.md`:
```
| [timestamp] | PLAN | AUDIT | /massu-plan | [session-id] |
```

**Execute the LOOP CONTROLLER below.**

1. Parse plan path from `$ARGUMENTS`
2. Start the loop: spawn `general-purpose` subagent (via Task tool) for iteration 1
3. Parse `GAPS_DISCOVERED` from the subagent result
4. If gaps > 0: fix what the auditor couldn't, spawn another iteration
5. If gaps == 0: output final report to user
6. Continue until zero gaps or max 10 iterations
7. **Score and append to command-scores.jsonl** (silent)

**The auditor subagent handles**: reading the plan, reading CLAUDE.md, extracting items, running verifications, fixing plan document gaps, returning structured result.

**You (the loop controller) handle**: spawning auditors, parsing results, fixing code-level gaps the auditor identifies but can't fix, and looping.

**Two sources of truth**:
- **Plan** = What to build
- **CLAUDE.md** = How to build it correctly

---

## MANDATORY LOOP CONTROLLER (EXECUTE THIS - DO NOT SKIP)

### How This Command Works

This command is a **loop controller**. Your job is to:
1. Spawn a `general-purpose` subagent for ONE audit pass
2. Parse the structured result (`GAPS_DISCOVERED: N`)
3. If gaps discovered > 0: the auditor may fix them, but you MUST spawn ANOTHER full pass
4. Only when a COMPLETE FRESH PASS discovers ZERO gaps can you declare complete

**You are NOT the auditor. You are the LOOP. The auditor runs inside Task subagents.**

### CRITICAL: GAPS_DISCOVERED Semantics

**`GAPS_DISCOVERED` = total gaps FOUND during the pass, REGARDLESS of whether they were also fixed.**

| Scenario | GAPS_DISCOVERED | Loop Action |
|----------|----------------|-------------|
| Pass finds 0 gaps | 0 | **EXIT** - audit complete |
| Pass finds 16 gaps, fixes all 16 | **16** (NOT 0) | **CONTINUE** - must re-audit |
| Pass finds 3 gaps, fixes 2, 1 needs controller | **3** | **CONTINUE** - fix remaining, re-audit |

**THE RULE**: A clean pass means zero gaps DISCOVERED from the start. Fixing gaps during a pass does NOT make it a clean pass. Only a fresh pass starting clean and finding nothing wrong proves the plan is correct.

### Execution Protocol

```
PLAN_PATH = $ARGUMENTS (the plan file path)
iteration = 0

WHILE true:
  iteration += 1

  # Spawn auditor subagent for ONE complete pass
  result = Task(subagent_type="general-purpose", model="opus", prompt="
    Audit iteration {iteration} for plan: {PLAN_PATH}
    This is a Massu plan (library/MCP server, NOT a web app).
    Execute ONE complete audit pass following all steps below.
    Read the plan from disk. Read .claude/CLAUDE.md. Verify all deliverables.
    Fix any plan document gaps you find.

    CONTEXT: Massu is a TypeScript monorepo with:
    - packages/core/src/ (MCP server source)
    - packages/core/src/__tests__/ (vitest tests)
    - packages/core/src/hooks/ (esbuild-compiled hooks)
    - massu.config.yaml (project config)
    - Tool registration: 3-function pattern (getDefs, isTool, handleCall) wired in tools.ts

    VR-* CHECKS (use ONLY these, per CLAUDE.md):
    - VR-FILE, VR-GREP, VR-NEGATIVE, VR-COUNT (generic)
    - VR-BUILD: npm run build (tsc + hooks)
    - VR-TYPE: cd packages/core && npx tsc --noEmit
    - VR-TEST: npm test (vitest)
    - VR-TOOL-REG: tool definitions + handler wired in tools.ts
    - VR-HOOK-BUILD: cd packages/core && npm run build:hooks
    - VR-CONFIG: massu.config.yaml parses
    - VR-PATTERN: bash scripts/massu-pattern-scanner.sh

    AUDIT STEPS:
    1. Read the plan file from disk (not memory)
    2. Read .claude/CLAUDE.md for rules
    3. Extract ALL deliverables into a numbered list
    4. For EACH deliverable, verify:
       a. Specificity: exact file path, exact changes, verification command
       b. Feasibility: target files exist (or create is planned), patterns are correct
       c. Completeness: all aspects covered (tool reg, tests, config if needed)
    5. Check pattern compliance matrix against massu patterns
    6. If adding tools: verify plan includes VR-TOOL-REG steps
    7. If modifying hooks: verify plan includes VR-HOOK-BUILD
    8. If changing config: verify plan includes VR-CONFIG
    9. Fix any gaps found in the plan document

    CRITICAL INSTRUCTION FOR GAPS_DISCOVERED:
    Report GAPS_DISCOVERED as the total number of gaps you FOUND during this pass,
    EVEN IF you also fixed them. Finding 16 gaps and fixing all 16 = GAPS_DISCOVERED: 16.
    A clean pass that finds nothing wrong from the start = GAPS_DISCOVERED: 0.

    Return the structured result block at the end:
    ---STRUCTURED-RESULT---
    ITERATION: {iteration}
    GAPS_DISCOVERED: [number]
    GAPS_FIXED: [number]
    GAPS_REMAINING: [number]
    PLAN_ITEMS_TOTAL: [number]
    PLAN_ITEMS_VERIFIED: [number]
    ---END-RESULT---
  ")

  # Parse structured result
  gaps = parse GAPS_DISCOVERED from result

  # Report iteration to user
  Output: "Iteration {iteration}: {gaps} gaps discovered"

  IF gaps == 0:
    Output: "AUDIT COMPLETE - Clean pass with zero gaps discovered in iteration {iteration}"
    BREAK
  ELSE:
    Output: "{gaps} gaps discovered (and possibly fixed) in iteration {iteration}, starting fresh re-audit..."
    CONTINUE
END WHILE
```

### Rules for the Loop Controller

| Rule | Meaning |
|------|---------|
| **NEVER output a final verdict while gaps > 0** | Only a zero-gap-from-start iteration produces the final report |
| **NEVER treat "found and fixed" as zero gaps** | Fixing during a pass still means gaps were discovered |
| **NEVER ask user "should I continue?"** | The loop is mandatory |
| **NEVER stop after fixing gaps** | Requires a FRESH re-audit to verify |
| **ALWAYS use Task tool for audit passes** | Subagents keep context clean |
| **ALWAYS parse GAPS_DISCOVERED from result** | This is the loop control variable |
| **Maximum 10 iterations** | If still failing after 10, report to user |

---

## Objective

Run a repeatable audit->fix->re-audit loop that verifies the entire plan against:
1. **The Plan** (source of truth for requirements)
2. **CLAUDE.md** (source of truth for rules, patterns, architecture constraints)

**CLAUDE.md is the ONLY authority on patterns. Do NOT infer patterns from the codebase.**

---

## CRITICAL: DUAL VERIFICATION REQUIREMENT

**This audit verifies BOTH plan quality AND plan feasibility.**

| Verification | What It Checks |
|--------------|----------------|
| **Plan Quality** | Is every deliverable specific, actionable, and verifiable? |
| **Plan Feasibility** | Can every deliverable actually be implemented? |

---

## PLAN ITEM EXTRACTION (MANDATORY FIRST STEP)

**Before auditing, extract ALL items from the plan into a trackable list.**

### Step 1: Read Plan Document (File, Not Memory)

### Step 2: Extract ALL Deliverables

```markdown
## PLAN ITEM EXTRACTION

### Plan Document
- **File**: [path]
- **Title**: [title]
- **Date Read**: [timestamp]

### Extracted Items

| Item # | Type | Description | Expected Location | Verification Command |
|--------|------|-------------|-------------------|---------------------|
| P1-001 | MODULE | foo-tools.ts | packages/core/src/ | ls -la [path] |
| P1-002 | TOOL_WIRE | Wire into tools.ts | packages/core/src/tools.ts | grep [module] tools.ts |
| P2-001 | TEST | foo-tools.test.ts | packages/core/src/__tests__/ | npm test |
| P-003 | REMOVAL | Remove pattern | all files | grep -rn "pattern" = 0 |

### Item Types: MODULE (exists), TOOL_WIRE (registered), TEST (passes), CONFIG (parses), HOOK (compiles), REMOVAL (0 matches)

### Coverage Baseline
- **Total Items**: [N]
- **Current Status**: 0/[N] verified (0%)
```

### Step 3: Use This List Throughout Audit
Every audit iteration must reference this list, check each item, update coverage, and report missing items.

---

## VR-PLAN-FEASIBILITY: Plan Reality Verification (MANDATORY)

**Before accepting ANY plan, verify it is REALISTIC and CAN be implemented.**

### Check 1: File System Reality
For files plan modifies: `ls -la [file_path]`. For directories plan creates in: `ls -la [directory_path]`.

### Check 1.5: Config-Code Data Alignment (VR-DATA)
If ANY feature uses config-stored values, verify VALUES match code expectations:
```bash
# Find what the CODE expects
grep -rn "getConfig\(\)\." packages/core/src/ | grep -oE 'getConfig\(\)\.\w+' | sort -u
```
Compare config keys to code expectations. Mismatches = FAIL. Add plan items to fix alignment BEFORE implementation.

### Check 2: Dependency Reality
For each new import: `npm list [package]` or `ls -la packages/core/src/[import-path].ts`.

### Check 3: Pattern Reality
For each pattern referenced: `grep -n "[pattern_name]" .claude/CLAUDE.md`.

### Check 4: Tool Registration Completeness
If plan adds MCP tools:
```bash
# Verify plan includes ALL 3 registration steps
grep "getToolDefinitions\|isXTool\|handleToolCall" [plan_file]
```

### Feasibility Gate Decision

| Check | Status |
|-------|--------|
| File System | PASS/FAIL |
| Config-Code Alignment | PASS/FAIL/N/A |
| Dependencies | PASS/FAIL |
| Patterns | PASS/FAIL |
| Tool Registration | PASS/FAIL |

**If ANY check fails: BLOCK plan until resolved. Do NOT proceed.**

---

## VR-PLAN-SPECIFICITY: Implementation Direction Verification (MANDATORY)

Every plan item MUST have implementation details specific enough to execute WITHOUT guessing.

| Item Type | Minimum Specificity |
|-----------|---------------------|
| **MODULE_CREATE** | File path + exported functions + pattern reference |
| **MODULE_MODIFY** | File path + exact changes + insertion point |
| **TOOL_WIRE** | tools.ts changes (import + definition + handler) |
| **TEST** | Test file path + what it covers + expected assertions |
| **CONFIG** | config.ts interface changes + YAML example |
| **HOOK** | Hook file path + stdin/stdout format + esbuild compatibility |

ANY item with vague implementation directions = FAIL. Fix the plan BEFORE implementation.

How to fix: Research target format, write exact content, specify insertion point, verify format against existing patterns, update plan.

---

## MANDATORY PATTERN ALIGNMENT GATE (PRE-IMPLEMENTATION)

The PLAN DOCUMENT itself must explicitly address ALL relevant patterns from CLAUDE.md.

### Pattern Compliance Matrix (Massu-Specific)

The auditor MUST verify plan items against these patterns:

| Pattern | Check | Expected |
|---------|-------|----------|
| ESM imports | No require() in plan code | 0 violations |
| Config access | getConfig() not direct YAML | Referenced correctly |
| Tool prefix | p() helper for tool names | All tool names use prefix |
| Tool registration | 3-function pattern | All 3 present per tool |
| Hook I/O | JSON stdin/stdout | Correct format |
| Test location | __tests__/ directory | Correct path |
| No process.exit() | Library code only | Not in plan modules |

### Steps
1. **Extract mandatory patterns** from CLAUDE.md
2. **Build alignment matrix**: Cross-reference plan against ALL extracted patterns

   ```markdown
   | Pattern ID | Pattern Requirement | Plan Addresses | Location in Plan | Status |
   |------------|---------------------|----------------|------------------|--------|
   | MCP-001 | 3-function tool pattern | YES/NO | Section X.X | ALIGNED/GAP |
   | CFG-001 | getConfig() usage | YES/NO | Section X.X | ALIGNED/GAP |
   ```

3. **Plan completeness check** - every plan MUST include:
   - Scope & Objectives
   - Files to Modify / Files to Create (explicit paths)
   - Module/Tool Registration (or N/A)
   - Error Handling approach
   - Testing Approach
   - Rollback Plan
   - Success Criteria
4. **Gap identification**: Document all missing info with recommendations

### Gate
ALL relevant patterns must be addressed. If FAIL: plan CANNOT proceed until gaps fixed.

### New Pattern Protocol
If plan requires functionality with no existing pattern:
1. Document why existing patterns don't work
2. Define pattern with WRONG/CORRECT examples
3. Get explicit user approval
4. Save to CLAUDE.md BEFORE implementation
5. Reference in plan

---

## Inputs You Must Read First (In Order)

1. **The Plan**: Read line-by-line, extract EVERY requirement into `REQUIREMENTS_CHECKLIST`
2. **CLAUDE.md**: Read fully, extract EVERY rule/pattern into `PATTERNS_CHECKLIST`

**Do NOT scan the repo to "discover" patterns. CLAUDE.md defines what patterns ARE correct.**

---

## PRIME DIRECTIVE: NO ASSUMPTIONS

**NEVER assume module interfaces or config structure. ALWAYS verify against real code.**

### Mandatory Structure Verification

```bash
# Verify module exports match plan expectations
grep -n "export" packages/core/src/[MODULE].ts

# Verify config interface matches plan
grep -A 20 "interface.*Config" packages/core/src/config.ts
```

---

## Operating Mode: Two-Pass Audit

### PASS A: Inventory & Mapping (NO FIXES YET)

#### A1. Requirements -> Implementation Matrix

```markdown
| Req ID | Requirement | Status | Evidence (file paths) | Notes |
|--------|-------------|--------|----------------------|-------|
| R-001 | [text] | Implemented/Partial/Missing/Unclear | [paths] | [notes] |
```

Status: **Implemented** (full evidence), **Partial** (some evidence), **Missing** (none found), **Unclear** (HARD STOP - ask for clarification).

#### A2. Patterns & Constraints Matrix

Primary verification:
```bash
bash scripts/massu-pattern-scanner.sh
# Exit 0 = ALL patterns pass
```

Additional targeted VR-NEGATIVE checks for rules not covered by scanner:
```bash
grep -rn "[violation pattern]" [directories] | wc -l
# Expected: 0
```

#### A3. User-Flow Coverage Map

```markdown
| Flow ID | Flow Name | Entry Point | Steps | API Calls | Expected Outcome | Status |
|---------|-----------|-------------|-------|-----------|------------------|--------|
| UF-001 | [name] | [module] | [list] | [list] | [outcome] | MAPPED |
```

---

### PASS B: Verification & Breakage Hunting

#### B1. Module / File Structure

```bash
# Module inventory
find packages/core/src -name "*.ts" -not -path "*__tests__*" -not -path "*node_modules*" | sort

# Tool definition files
find packages/core/src -name "*-tools.ts" | sort

# Hook files
find packages/core/src/hooks -name "*.ts" 2>/dev/null | sort
```

Verify: all planned modules exist, all tool files follow naming convention, hooks are in correct directory.

#### B2. Tool Registration & Wiring

```bash
# Tool definitions in each module
grep -rn "getToolDefinitions\|getDefs" packages/core/src/ | grep -v node_modules | grep -v __tests__

# Handler registrations
grep -rn "handleToolCall\|handleCall" packages/core/src/ | grep -v node_modules | grep -v __tests__

# Wiring in tools.ts
grep -rn "import\|getDefs\|isTool\|handleCall" packages/core/src/tools.ts
```

Verify: all tools have definitions + handlers + wiring in tools.ts. A tool that exists but is not registered is INVISIBLE to users.

#### B2.5 Tool Registration Matrix

```markdown
### Tool Registration Matrix

| Tool Name | getDefs() | isTool() | handleCall() | wired in tools.ts | Test | Status |
|-----------|-----------|----------|--------------|-------------------|------|--------|
| [name] | [file:line] | [file:line] | [file:line] | YES/NO | [test] | PASS/FAIL |
```

#### B3. Data Layer Integrity

```bash
cd packages/core && npx tsc --noEmit
# Compare module interfaces to usage
grep -A 10 "export interface\|export type" packages/core/src/[MODULE].ts
```

#### B4. Hook Compilation

```bash
cd packages/core && npm run build:hooks
# MUST exit 0
```

#### B4.5 Hook Compilation Matrix

If plan includes hooks:

```markdown
### Hook Compilation Matrix

| Hook | File | stdin format | stdout format | esbuild compatible | Status |
|------|------|-------------|---------------|-------------------|--------|
| [name] | [path] | [format] | [format] | YES/NO | PASS/FAIL |
```

#### B5. Config Validation

If plan includes config changes:

```markdown
### Config Validation Matrix

| Config Section | Interface in config.ts | Example in YAML | Default value | Status |
|----------------|----------------------|-----------------|---------------|--------|
| [section] | YES/NO | YES/NO | [value] | PASS/FAIL |
```

#### B6. Regression Risk

```bash
git log --oneline -20
git diff HEAD~5 --stat
```

Review for side effects, incomplete refactors, duplicated logic, silent failures.

#### B7. Consistency & Reusability

Reuse existing modules per CLAUDE.md. Do NOT create one-off modules when reusable ones exist.

#### B8. Import/Export Integrity

```bash
cd packages/core && npx tsc --noEmit 2>&1 | grep -i "cannot find module\|not found"
```

#### B9. Environment & Configuration

```bash
grep -rn "process.env\." packages/core/src/ | grep -v node_modules | grep -oE 'process\.env\.\w+' | sort -u
ls -la tsconfig.json package.json massu.config.yaml 2>/dev/null
```

#### B10. Test Coverage

```bash
# Test files
find packages/core/src/__tests__ -name "*.test.ts" | sort

# Run tests
npm test
```

Verify: all new modules have corresponding test files, all tests pass.

#### B11. Third-Party Integration

```bash
grep -rn "fetch(\|axios\." packages/core/src/ | grep -v node_modules | grep -v __tests__ | head -20
grep -rn "https://\|http://" packages/core/src/ | grep -v node_modules | grep -v ".env\|localhost" | head -10
```

### Blast Radius Verification

When plan changes ANY constant/path/value:
```bash
# For EACH changed value:
grep -rn '"[OLD_VALUE]"' packages/core/src/ --include="*.ts" | grep -v node_modules
# ALL matches must be accounted for in blast radius analysis
```

Produce matrix: Old Value | Total Refs | Changed | Kept (with reason) | Uncategorized | Status. Zero uncategorized = PASS.

---

## Fix Protocol (When Gaps Found)

Sort by severity: **P0** (broken tools, data loss, security) > **P1** (incorrect behavior, missing requirements) > **P2** (consistency, minor gaps).

For each fix:
1. Edit the plan document directly
2. Add missing detail or correct errors
3. Mark the fix with a comment: `<!-- Fixed in audit iteration N -->`

### Technical Debt
If fixes introduce debt: add to Technical Debt Register with concrete removal plan, document in session-state/CURRENT.md.

---

## Audit Loop (Repeat Until ZERO Gaps)

```
ITERATION N:
  1. Run PASS A (Inventory & Mapping)
  2. Run PASS B (Verification & Breakage Hunting)
  3. Produce Report
  4. IF gaps: Build Fix Queue (P0->P1->P2), apply fixes, verify, return to Step 1
  5. IF zero gaps: Verify completion criteria, produce final report, STOP
```

### Stop Conditions (ALL must be true)

**Plan Coverage**: 100% items verified with VR-* proof.
**Requirements**: 100% Implemented with evidence.
**Pattern Compliance**: massu-pattern-scanner exits 0, all VR-NEGATIVE checks pass.
**Build & Types**: `npm run build` exit 0, `cd packages/core && npx tsc --noEmit` 0 errors, `npm test` passes.
**Blast Radius** (if applicable): Zero uncategorized references.
**Technical Debt**: Empty OR fully planned with cleanup steps.

---

## Report Format (Every Loop Iteration)

### A. Executive Summary
```markdown
## MASSU PLAN AUDIT - Iteration [N]
**Date**: [YYYY-MM-DD] | **Plan**: [path] | **Stop Condition**: NOT MET / MET

| P0 | P1 | P2 | Total |
|----|----|----|-------|
| X  | X  | X  | X     |

### Key Findings
- [Finding 1]
- [Finding 2]
```

### B. Requirements Coverage
Req ID | Requirement | Status | Evidence (file paths) | Notes

### C. Pattern Compliance
Rule | Status | Violations | Fix Plan/Proof

### D. Tool Registration Verification
Tool | Definition | Handler | Wired | Test | Status

### E. Technical Debt Register
ID | Item | Impact | Remediation | Target

### F. Fix Queue + Completed Fixes
Completed: fix, files changed, verification. Remaining: priority, fix, blocker.

---

## Completion Criteria

```markdown
## COMPLETION DECLARATION

### Plan Coverage: 100% Verified
- Total plan items: [N], Verified: [N] (100%)
- Evidence: Plan Item Extraction table with VR-* proof

### Requirements: 100% Implemented
- Evidence: VR-GREP and VR-FILE proof for each

### Patterns: 0 Violations
- Pattern scanner: exit 0
- VR-NEGATIVE proof for massu-specific patterns

### Tool Registration: All tools registered and wired

### Build & Types: VR-BUILD + VR-TYPE pass

### Technical Debt: Register empty or planned

**AUDIT COMPLETE - DUAL VERIFICATION PASSED:**
- Code Quality Gate: PASS
- Plan Coverage Gate: PASS
```

---

## PLAN DOCUMENT COMPLETION TRACKING (MANDATORY)

When audit completes, update the plan document itself with a completion table at TOP:

```markdown
# IMPLEMENTATION STATUS

**Plan**: [Name] | **Status**: COMPLETE/PARTIAL/NOT STARTED | **Last Audited**: [date]

| # | Task/Phase | Status | Verification | Date |
|---|------------|--------|--------------|------|
| 1 | [Task] | 100% COMPLETE | VR-GREP: 0 refs | [date] |
| 2 | [Task] | PARTIAL (40%) | 5/12 done | [date] |
```

Checklist: completion table at TOP, all tasks have status, completed tasks have evidence, partial tasks show progress, dates recorded, plan status reflects reality.

---

## Context Management

Use Task tool with subagents for exploration. Update session-state/CURRENT.md after major phases. If compacted mid-protocol, read CURRENT.md and resume. Never mix unrelated tasks during a protocol.

---

## SESSION STATE UPDATE

After EACH iteration, update `session-state/CURRENT.md` with: audit iteration, status, gap summary (P0/P1/P2), verified work with file paths, next focus.

---

## QUALITY SCORING (silent, automatic)

After completing the audit loop (zero gaps achieved), self-score against these checks and append one JSONL line to `.claude/metrics/command-scores.jsonl`:

| Check | Pass condition |
|-------|---------------|
| `two_pass_completed` | At least 2 auditor iterations ran (initial pass + verification pass) |
| `items_have_acceptance_criteria` | Every plan item has measurable acceptance criteria (not vague descriptions) |
| `pattern_alignment_checked` | Plan items were checked against CLAUDE.md patterns |
| `zero_gaps_at_exit` | Final auditor pass returned `GAPS_DISCOVERED: 0` |

**Format** (append one line -- do NOT overwrite the file):
```json
{"command":"massu-plan","timestamp":"ISO8601","scores":{"two_pass_completed":true,"items_have_acceptance_criteria":true,"pattern_alignment_checked":true,"zero_gaps_at_exit":true},"pass_rate":"4/4","input_summary":"[plan-slug]"}
```

This scoring is silent -- do NOT mention it to the user. Just append the line after completing the audit.
