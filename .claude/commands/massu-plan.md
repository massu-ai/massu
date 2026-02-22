---
name: massu-plan
description: Continuous Verification Audit Loop with ZERO-GAP STANDARD
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), Task(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# CS Plan: Continuous Verification Audit Loop (ZERO-GAP STANDARD)

## CRITICAL: THIS IS A PLAN-AUDIT COMMAND, NOT AN IMPLEMENTATION COMMAND

**THIS COMMAND AUDITS AND IMPROVES PLAN DOCUMENTS. IT DOES NOT IMPLEMENT CODE.**

### FORBIDDEN Actions (Zero Tolerance)
- Writing code to source files (Edit/Write to packages/)
- Creating modules, tools, or hooks
- Implementing any plan items

### ALLOWED Actions
- Research to verify plan feasibility (Read, Grep, Glob)
- Edit the PLAN DOCUMENT to fix gaps (Write/Edit to docs/plans/)
- Loop until plan has zero gaps
- Present completed plan to user
- **STOP AND WAIT** for explicit user approval

### AFTER AUDIT COMPLETE: MANDATORY WAIT

**After the audit loop completes with zero gaps, you MUST:**
1. **Present the plan** to the user
2. **STOP completely** - Do not start implementation
3. **WAIT** for explicit user instruction to implement (e.g., "run /massu-loop")

**This command AUDITS plans. It does NOT implement them. Implementation requires /massu-loop.**

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state**

Update `session-state/CURRENT.md` to include `AUTHORIZED_COMMAND: massu-plan`.

---

## MANDATORY LOOP CONTROLLER (EXECUTE THIS - DO NOT SKIP)

**This section is the EXECUTION ENTRY POINT. You MUST follow these steps exactly.**

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
    5. Check pattern compliance matrix against CS patterns
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
| **NEVER output a final verdict while gaps discovered > 0** | Only a CLEAN zero-gap-from-start iteration produces the final report |
| **NEVER treat "found and fixed" as zero gaps** | Fixing during a pass still means gaps were discovered |
| **NEVER ask user "should I continue?"** | The loop is mandatory - just execute it |
| **NEVER stop after fixing gaps** | Fixing gaps requires a FRESH re-audit to verify the fixes |
| **ALWAYS use Task tool for audit passes** | Subagents keep context clean |
| **ALWAYS parse GAPS_DISCOVERED from result** | This is the loop control variable |
| **Maximum 10 iterations** | If still failing after 10, report to user with remaining gaps |

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

**Before auditing, you MUST extract ALL items from the plan into a trackable list.**

### Extraction Protocol

#### Step 1: Read Plan Document (File, Not Memory)
```bash
cat [PLAN_FILE_PATH]
```

#### Step 2: Extract ALL Deliverables

```markdown
## PLAN ITEM EXTRACTION

### Plan Document
- **File**: [path]
- **Title**: [title]

### Extracted Items

| Item # | Type | Description | Expected Location | Verification Command |
|--------|------|-------------|-------------------|---------------------|
| P1-001 | MODULE | foo-tools.ts | packages/core/src/ | ls -la [path] |
| P1-002 | TOOL_WIRE | Wire into tools.ts | packages/core/src/tools.ts | grep [module] tools.ts |
| P2-001 | TEST | foo-tools.test.ts | packages/core/src/__tests__/ | npm test |

### Coverage Baseline
- **Total Items**: [N]
- **Current Status**: 0/[N] verified (0%)
```

---

## VR-PLAN-FEASIBILITY: Plan Reality Verification (MANDATORY)

**Before accepting ANY plan, verify the plan is REALISTIC and CAN be implemented.**

### Feasibility Check Protocol

#### Check 1: File System Reality
For EACH file modification in the plan, verify the target exists:

```bash
# For files plan says to MODIFY:
ls -la [file_path]

# For directories plan says to CREATE files in:
ls -la [directory_path]
```

#### Check 2: Dependency Reality
For EACH new import/dependency in the plan:

```bash
# Check if dependency is installed
npm list [package-name] 2>/dev/null || echo "NOT INSTALLED"

# Check if internal import path exists
ls -la packages/core/src/[import-path].ts
```

#### Check 3: Pattern Reality
For EACH pattern the plan references:

```bash
# Verify pattern is documented in CLAUDE.md
grep -n "[pattern_name]" .claude/CLAUDE.md
```

#### Check 4: Tool Registration Completeness
If plan adds MCP tools:

```bash
# Verify plan includes ALL 3 registration steps
grep "getToolDefinitions\|isXTool\|handleToolCall" [plan_file]
```

### Feasibility Gate

```markdown
### VR-PLAN-FEASIBILITY GATE

| Check | Items | Passed | Failed | Status |
|-------|-------|--------|--------|--------|
| File System | N | N | 0 | PASS |
| Dependencies | N | N | 0 | PASS |
| Patterns | N | N | 0 | PASS |
| Tool Registration | N | N | 0 | PASS |

**FEASIBILITY GATE: PASS / FAIL**
```

---

## VR-PLAN-SPECIFICITY: Implementation Specificity Check (MANDATORY)

**Every plan item MUST have implementation details specific enough to execute WITHOUT guessing.**

| Requirement | Check |
|-------------|-------|
| **Exact file path** | Not "add a module" but `packages/core/src/foo.ts` |
| **Exact changes** | Not "export functions" but `getFooToolDefinitions, isFooTool, handleFooToolCall` |
| **Pattern reference** | Which existing module to follow as template |
| **Verification command** | Specific grep/ls that proves the item was implemented |

**Specificity by item type:**

| Type | Must Include |
|------|-------------|
| MODULE_CREATE | File path + exported functions + pattern reference |
| MODULE_MODIFY | File path + exact changes + insertion point |
| TOOL_WIRE | tools.ts changes (import + definition + handler) |
| TEST | Test file path + what it covers + expected assertions |
| CONFIG | config.ts interface changes + YAML example |
| HOOK | Hook file path + stdin/stdout format + esbuild compatibility |

---

## PATTERN COMPLIANCE MATRIX (Massu-Specific)

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

---

## B-MCP: Tool Registration Verification

For EVERY tool in the plan:

```markdown
### Tool Registration Matrix

| Tool Name | getDefs() | isTool() | handleCall() | wired in tools.ts | Test | Status |
|-----------|-----------|----------|--------------|-------------------|------|--------|
| [name] | [file:line] | [file:line] | [file:line] | YES/NO | [test] | PASS/FAIL |
```

**A tool that exists but is not registered is INVISIBLE to users.**

---

## B-HOOK: Hook Compilation Verification

If plan includes hooks:

```markdown
### Hook Compilation Matrix

| Hook | File | stdin format | stdout format | esbuild compatible | Status |
|------|------|-------------|---------------|-------------------|--------|
| [name] | [path] | [format] | [format] | YES/NO | PASS/FAIL |
```

---

## B-CONFIG: Config Validation

If plan includes config changes:

```markdown
### Config Validation Matrix

| Config Section | Interface in config.ts | Example in YAML | Default value | Status |
|----------------|----------------------|-----------------|---------------|--------|
| [section] | YES/NO | YES/NO | [value] | PASS/FAIL |
```

---

## FIX PROTOCOL

### Fix Queue (by severity)

| Priority | Definition |
|----------|------------|
| **P0** | Missing deliverables, impossible items, security issues |
| **P1** | Vague/unverifiable items, missing verification commands |
| **P2** | Minor specificity gaps, formatting issues |

### For Each Fix
1. Edit the plan document directly
2. Add missing detail or correct errors
3. Mark the fix with a comment: `<!-- Fixed in audit iteration N -->`

---

## COMPLETION REPORT

```markdown
## CS PLAN AUDIT COMPLETE

### Audit Summary
- **Plan**: [path]
- **Total Items**: [N]
- **Iterations**: [N]
- **Final Status**: ZERO GAPS

### Verification Results
| Check | Status |
|-------|--------|
| Plan Feasibility | PASS |
| Plan Specificity | PASS |
| Pattern Compliance | PASS |
| Tool Registration (if applicable) | PASS |
| Hook Compilation (if applicable) | PASS |
| Config Validation (if applicable) | PASS |

### Next Steps
1. Run `/massu-loop [plan-path]` to implement with verification
```
