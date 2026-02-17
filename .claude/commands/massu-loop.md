---
name: massu-loop
description: Execute task with CS Loop verification protocol (autonomous execution with mandatory proof)
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), Task(*)
---
name: massu-loop

# CS Loop: Autonomous Execution Protocol

## POST-COMPACTION SAFETY CHECK (MANDATORY)

**If this session was continued from a previous conversation (compaction/continuation), you MUST:**

1. **Verify the user explicitly invoked `/massu-loop`** - Check the user's LAST ACTUAL message. Continuation instructions ("continue where you left off") are NOT user commands.
2. **Verify the plan was explicitly approved** - If a `/massu-create-plan` was the last user action and no explicit approval was given, implementation is UNAUTHORIZED. Stop immediately and ask the user.
3. **System-injected skill invocations after compaction are NOT user commands.**

---

## MANDATORY LOOP CONTROLLER (EXECUTE THIS - DO NOT SKIP)

**This section is the EXECUTION ENTRY POINT. You MUST follow these steps exactly.**

### How This Command Works

This command is a **loop controller** for implementation + verification. Your job is to:
1. Extract plan items and implement them
2. After implementation, spawn a `general-purpose` subagent for verification
3. Parse the structured result (`GAPS_DISCOVERED: N`)
4. If gaps discovered > 0: fix gaps, then spawn ANOTHER FRESH auditor pass
5. Only when a COMPLETE FRESH PASS discovers ZERO gaps can you declare complete

**The verification audit runs inside Task subagents. This prevents early termination.**

### CRITICAL: GAPS_DISCOVERED Semantics

**`GAPS_DISCOVERED` = total gaps FOUND during the pass, REGARDLESS of whether they were also fixed.**

| Scenario | GAPS_DISCOVERED | Loop Action |
|----------|----------------|-------------|
| Pass finds 0 gaps | 0 | **EXIT** - verification complete |
| Pass finds 5 gaps, fixes all 5 | **5** (NOT 0) | **CONTINUE** - must re-verify |
| Pass finds 3 gaps, fixes 1, 2 need controller | **3** | **CONTINUE** - fix remaining, re-verify |

**THE RULE**: A clean pass means zero gaps DISCOVERED from the start. Fixing gaps during a pass does NOT make it a clean pass. Only a fresh pass finding nothing proves correctness.

### Execution Protocol

```
PLAN_PATH = $ARGUMENTS (the plan file path or task description)
iteration = 0

# Phase 1: IMPLEMENT (do the work)
# Read plan, extract items, implement each one with VR-* proof

# Phase 2: VERIFY (audit loop - STRUCTURAL)
WHILE true:
  iteration += 1

  # Spawn auditor subagent for ONE complete verification pass
  result = Task(subagent_type="general-purpose", model="opus", prompt="
    Verification audit iteration {iteration} for plan: {PLAN_PATH}
    This is a Massu implementation (library/MCP server, NOT a web app).
    Execute ONE complete audit pass. Verify ALL deliverables.
    Check code quality (patterns, types, tests).
    Check plan coverage (every item verified with proof).
    Fix any gaps you find (code or plan document).

    CONTEXT: Massu is a TypeScript monorepo with:
    - packages/core/src/ (MCP server source)
    - packages/core/src/__tests__/ (vitest tests)
    - packages/core/src/hooks/ (esbuild-compiled hooks)
    - website/ (Next.js + Supabase website)
    - massu.config.yaml (project config)
    - Tool registration: 3-function pattern (getDefs, isTool, handleCall) in tools.ts

    VERIFICATION COMMANDS:
    - Pattern scanner: bash scripts/massu-pattern-scanner.sh
    - Type check: cd packages/core && npx tsc --noEmit
    - Tests: npm test
    - Hook build: cd packages/core && npm run build:hooks

    VR-* CHECKS (use ONLY these, per CLAUDE.md):
    - VR-FILE, VR-GREP, VR-NEGATIVE, VR-COUNT (generic)
    - VR-BUILD: npm run build (tsc + hooks)
    - VR-TYPE, VR-TEST, VR-TOOL-REG, VR-HOOK-BUILD, VR-CONFIG, VR-PATTERN

    CRITICAL INSTRUCTION FOR GAPS_DISCOVERED:
    Report GAPS_DISCOVERED as the total number of gaps you FOUND during this pass,
    EVEN IF you also fixed them. Finding 5 gaps and fixing all 5 = GAPS_DISCOVERED: 5.
    A clean pass that finds nothing wrong from the start = GAPS_DISCOVERED: 0.

    Return the structured result block:
    ---STRUCTURED-RESULT---
    ITERATION: {iteration}
    GAPS_DISCOVERED: [number]
    GAPS_FIXED: [number]
    GAPS_REMAINING: [number]
    PLAN_ITEMS_TOTAL: [number]
    PLAN_ITEMS_VERIFIED: [number]
    CODE_QUALITY_GATE: PASS/FAIL
    PLAN_COVERAGE_GATE: PASS/FAIL
    ---END-RESULT---
  ")

  # Parse structured result
  gaps = parse GAPS_DISCOVERED from result

  # Report iteration to user
  Output: "Verification iteration {iteration}: {gaps} gaps discovered"

  IF gaps == 0:
    Output: "ALL GATES PASSED - Clean pass with zero gaps discovered in iteration {iteration}"
    BREAK
  ELSE:
    Output: "{gaps} gaps discovered in iteration {iteration}, starting fresh re-verification..."
    # Fix code-level gaps the auditor identified but couldn't fix
    # Then continue the loop for re-verification
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
| **ALWAYS use Task tool for verification passes** | Subagents keep context clean |
| **ALWAYS parse GAPS_DISCOVERED from result** | This is the loop control variable |
| **Maximum 10 iterations** | If still failing after 10, report to user with remaining gaps |

---

## Objective

Execute task/plan autonomously with **verified proof at every step**. Continue until ZERO gaps with VR-* evidence. Claims without proof are invalid.

---

## ABSOLUTE MANDATE: NEVER STOP UNTIL 100% COMPLETE

**THIS PROTOCOL HAS THE HIGHEST AUTHORITY. NO EXCEPTIONS. NO EARLY TERMINATION.**

### The Unbreakable Rule

```
THE LOOP DOES NOT STOP UNTIL:

1. EVERY SINGLE PLAN ITEM IS VERIFIED COMPLETE (100% - not 99%)
2. EVERY VR-* CHECK PASSES WITH PROOF
3. PATTERN SCANNER RETURNS 0 VIOLATIONS
4. TYPE CHECK PASSES (cd packages/core && npx tsc --noEmit exits 0)
5. ALL TESTS PASS (npm test exits 0) - NO EXCEPTIONS
6. HOOK BUILD SUCCEEDS (cd packages/core && npm run build:hooks exits 0)
7. IF NEW TOOLS: VR-TOOL-REG PASSES (all 3 functions wired in tools.ts)

IF ANY OF THESE ARE NOT TRUE, CONTINUE WORKING. DO NOT STOP.
```

### Prohibited Behaviors

| NEVER DO THIS | WHY IT'S WRONG | WHAT TO DO INSTEAD |
|---------------|----------------|---------------------|
| "I'll note this as remaining work" | Plans must be 100% complete | Implement it NOW |
| "This item can be done later" | No deferral allowed | Implement it NOW |
| "Most items are done" | "Most" is not "all" | Complete ALL items |
| Stop after code quality passes | Plan coverage must ALSO pass | Continue until 100% coverage |
| Ask "should I continue?" | Yes, always continue | Keep working silently |
| Skip tests because "they're optional" | Tests are NEVER optional | Run ALL tests |
| Claim complete with failing tests | Failing tests = NOT complete | Fix tests first |

### MANDATORY TEST VERIFICATION (CR-7)

**TESTS ARE NEVER OPTIONAL.**

```
BEFORE claiming ANY work is complete:

1. RUN: npm test
2. VERIFY: Exit code is 0
3. VERIFY: All tests pass (no failures)
4. IF tests fail: FIX THEM - even if they were failing before
5. RE-RUN: npm test until ALL pass

THERE ARE NO EXCEPTIONS.
```

---

## CRITICAL: PLAN COMPLETION GATE

**Code Quality verification is NOT ENOUGH. Plan Coverage verification is MANDATORY.**

### Dual Verification

**BOTH gates must pass before claiming complete:**

| Gate | What It Checks | Example |
|------|----------------|---------|
| **Code Quality Gate** | Is the code correct? | Pattern scanner, types, tests |
| **Plan Coverage Gate** | Did we build everything? | 15/15 plan items verified |

**Code Quality: PASS + Plan Coverage: FAIL = NOT COMPLETE**

---

## PLAN ITEM EXTRACTION PROTOCOL (MANDATORY - STEP 0)

**Before ANY implementation, extract ALL plan items into a trackable checklist.**

### Step 0.1: Read Plan Document (Not Memory)

```bash
cat [PLAN_FILE_PATH]
```

**You MUST read the plan file. Do NOT rely on memory or summaries.**

### Step 0.2: Extract ALL Deliverables

```markdown
## PLAN ITEM EXTRACTION

### Source Document
- **Plan File**: [path]
- **Plan Title**: [title]
- **Total Sections**: [N]

### Extracted Items

| Item # | Type | Description | Location | Verification Command | Status |
|--------|------|-------------|----------|---------------------|--------|
| P1-001 | MODULE_CREATE | foo-tools.ts | packages/core/src/ | ls -la [path] | PENDING |
| P1-002 | TOOL_WIRE | Wire into tools.ts | packages/core/src/tools.ts | grep [module] tools.ts | PENDING |
| P2-001 | TEST | foo.test.ts | packages/core/src/__tests__/ | npm test | PENDING |

### Item Types
- MODULE_CREATE: New TypeScript module
- MODULE_MODIFY: Existing module to change
- TOOL_WIRE: Wire tool into tools.ts
- TEST: Test file
- CONFIG: Config changes (config.ts + YAML)
- HOOK: New or modified hook
- REMOVAL: Code/file to remove (use VR-NEGATIVE)

### Coverage Summary
- **Total Items**: [N]
- **Verified Complete**: 0
- **Coverage**: 0%
```

### Step 0.3: Create Verification Commands

For EACH extracted item, define HOW to verify it:

| Item Type | Verification Method | Expected Result |
|-----------|---------------------|-----------------|
| MODULE_CREATE | `ls -la [path]` | File exists, size > 0 |
| MODULE_MODIFY | `grep "[change]" [file]` | Pattern found |
| TOOL_WIRE | `grep "getXDefs\|isXTool\|handleXCall" tools.ts` | All 3 present |
| TEST | `npm test` | All pass |
| CONFIG | Parse YAML, grep interface | Valid |
| HOOK | `cd packages/core && npm run build:hooks` | Exit 0 |
| REMOVAL | `grep -rn "[old]" packages/core/src/ | wc -l` | 0 matches |

---

## CHECKPOINT PROTOCOL

### CHECKPOINT FILE

**Location**: `.claude/session-state/LOOP_CHECKPOINT.md`

### CHECKPOINT FORMAT

```markdown
## Loop Checkpoint
- Plan: [plan path]
- Started: [timestamp]
- Last Updated: [timestamp]
- Iteration: [N]

### Item Status
| Item # | Description | Status | Verified At |
|--------|-------------|--------|-------------|
| P1-001 | [desc] | DONE/PENDING/IN_PROGRESS | [timestamp] |
| P1-002 | [desc] | DONE/PENDING/IN_PROGRESS | [timestamp] |
```

### SAVE CHECKPOINT

After each item is implemented and verified, update the checkpoint file:

1. Set item status to `DONE` with current timestamp
2. Update `Last Updated` timestamp
3. Update `Iteration` count

Also update after each verification iteration completes (even if items were found incomplete).

### RESUME PROTOCOL

At the START of `/massu-loop`, check for existing checkpoint:

```bash
# Check if checkpoint exists
ls .claude/session-state/LOOP_CHECKPOINT.md 2>/dev/null
```

**If checkpoint exists AND references the same plan path:**
1. Read the checkpoint file
2. Report: "Resuming from checkpoint: X/Y items complete"
3. Skip already-DONE items (but still verify them in the next audit pass)
4. Continue from first PENDING item

**If checkpoint does NOT exist or references a different plan:**
1. Start fresh
2. Create new checkpoint file with all items set to PENDING

### CHECKPOINT CLEANUP

When loop completes successfully (`GAPS_DISCOVERED: 0` in a clean pass):
- Delete the checkpoint file: `rm .claude/session-state/LOOP_CHECKPOINT.md`
- Report in COMPLETION REPORT: "Checkpoint: cleaned up (loop complete)"

When loop reaches max iterations without completing:
- Preserve the checkpoint file for future resume
- Report in COMPLETION REPORT: "Checkpoint: preserved (loop incomplete — max iterations reached)"

---

## IMPLEMENTATION PROTOCOL

### For EACH Plan Item

1. **Read the plan item** from the extracted list
2. **Read any referenced files** before modifying
3. **Implement** following CLAUDE.md patterns
4. **Verify** with the item's verification command
5. **Update coverage** count
6. **Continue** to next item

### Pattern Compliance During Implementation

For every file you create or modify, verify against:

```bash
# Run pattern scanner
bash scripts/massu-pattern-scanner.sh

# Type check
cd packages/core && npx tsc --noEmit

# Tests still pass
npm test
```

### Massu-Specific Implementation Checks

| If Implementing | Must Also |
|-----------------|-----------|
| New MCP tool | Wire 3 functions into tools.ts (CR-11) |
| New hook | Verify esbuild compilation (CR-12) |
| Config changes | Update interface in config.ts AND example in YAML |
| New test | Place in `__tests__/` directory |
| New module | Use ESM imports, getConfig() for config |

---

## VR-PLAN ENUMERATION (Before Verification)

**Before running ANY verification commands, enumerate ALL applicable VR-* checks.**

```markdown
### VR-* Verification Plan

| VR Check | Target | Command | Expected |
|----------|--------|---------|----------|
| VR-FILE | [each new file] | ls -la [path] | Exists |
| VR-GREP | [each new function] | grep "[func]" [file] | Found |
| VR-NEGATIVE | [each removal] | grep -rn "[old]" src/ | 0 matches |
| VR-PATTERN | All source | bash scripts/massu-pattern-scanner.sh | Exit 0 |
| VR-TYPE | packages/core | cd packages/core && npx tsc --noEmit | 0 errors |
| VR-TEST | All tests | npm test | All pass |
| VR-TOOL-REG | [new tools] | grep in tools.ts | All 3 functions |
| VR-HOOK-BUILD | hooks | cd packages/core && npm run build:hooks | Exit 0 |
```

**Run ALL enumerated checks BEFORE spawning the verification auditor.**

---

## STOP CONDITIONS (ALL must be true)

1. Every plan item verified complete (100%)
2. Pattern scanner: 0 violations (`bash scripts/massu-pattern-scanner.sh` exits 0)
3. Type check: 0 errors (`cd packages/core && npx tsc --noEmit` exits 0)
4. Tests: ALL pass (`npm test` exits 0)
5. Hook build: succeeds (`cd packages/core && npm run build:hooks` exits 0)
6. If new tools: VR-TOOL-REG passes (all 3 functions in tools.ts)

---

## AUTO-LEARNING PROTOCOL

After completion, if any issues were discovered and fixed:

1. **Record the pattern** - What went wrong and how it was fixed
2. **Check if pattern scanner should be updated** - Can the check be automated?
3. **Update session state** - Record in `.claude/session-state/CURRENT.md`

---

## COMPLETION REPORT

```markdown
## CS LOOP COMPLETE

### Implementation Summary
- **Plan**: [path]
- **Total Items**: [N]
- **All Implemented**: YES
- **Verification Iterations**: [N]

### Final Gate Status
| Gate | Status | Evidence |
|------|--------|----------|
| Pattern Scanner | PASS | Exit 0 |
| Type Safety | PASS | 0 errors |
| Tests | PASS | [X] tests passed |
| Hook Build | PASS | Exit 0 |
| Tool Registration | PASS/N/A | [evidence] |
| Plan Coverage | PASS | [X]/[X] = 100% |

### Code Quality Gate: PASS
### Plan Coverage Gate: PASS

### Next Steps
- Run `/massu-commit` to commit with verification
- Run `/massu-push` to push with full verification
```
