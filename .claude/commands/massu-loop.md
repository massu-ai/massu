---
name: massu-loop
description: Execute task with CS Loop verification protocol (autonomous execution with mandatory proof)
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), Task(*)
---
name: massu-loop

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# CS Loop: Autonomous Execution Protocol

## Workflow Position

```
/massu-create-plan -> /massu-plan -> /massu-loop -> /massu-commit -> /massu-push
(CREATE)           (AUDIT)        (IMPLEMENT)   (COMMIT)        (PUSH)
```

**This command is step 3 of 5 in the standard workflow.**

---

## MANDATORY LOOP CONTROLLER (EXECUTE THIS - DO NOT SKIP)

**This section is the EXECUTION ENTRY POINT. You MUST follow these steps exactly.**

### How This Command Works

This command is a **loop controller** for implementation + verification. Your job is to:
1. Extract plan items and implement them
2. After implementation, spawn focused review subagents IN PARALLEL for independent analysis
3. After reviews, spawn a `general-purpose` subagent for verification
4. Parse the structured result (`GAPS_DISCOVERED: N`)
5. If gaps discovered > 0: fix gaps, then spawn ANOTHER FRESH auditor pass
6. Only when a COMPLETE FRESH PASS discovers ZERO gaps can you declare complete

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

# Phase 1.5: MULTI-PERSPECTIVE REVIEW (after implementation, before verification)
# Spawn focused review subagents IN PARALLEL for independent analysis
# Each reviewer has an adversarial mindset and a SINGLE focused concern (Principle #20)
# Elegance/simplicity assessment happens in Phase 2.1 POST-BUILD REFLECTION (Q4)

security_result = Task(subagent_type="general-purpose", model="opus", prompt="
  Review implementation for plan: {PLAN_PATH}
  Focus: Security vulnerabilities, auth gaps, input validation, data exposure
  Check all new/modified files. Return structured result with SECURITY_GATE.
")

architecture_result = Task(subagent_type="general-purpose", model="opus", prompt="
  Review implementation for plan: {PLAN_PATH}
  Focus: Design issues, coupling problems, pattern compliance, scalability
  Check all new/modified files. Return structured result with ARCHITECTURE_GATE.
")

# Parse results and fix any CRITICAL/HIGH findings before proceeding to verification
# FAIL gate = must fix before proceeding
# WARN findings = document and proceed

# Phase 2: VERIFY (audit loop - STRUCTURAL)
WHILE true:
  iteration += 1

  # Run circuit breaker check (detect stagnation)
  # If same gaps appear 3+ times with no progress, consider changing approach
  IF iteration > 3 AND no_progress_count >= 3:
    Output: "CIRCUIT BREAKER: The current approach is not converging after {iteration} passes."
    Output: "Options: (a) Re-plan with different approach (b) Continue current approach (c) Stop"
    AskUserQuestion: "The loop has stalled. How should we proceed?"
    IF user chooses re-plan: STOP loop, output current state, recommend /massu-create-plan
    IF user chooses continue: CONTINUE loop (reset circuit breaker)
    IF user chooses stop: STOP loop, output current state as incomplete

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

# Phase 2.1: POST-BUILD REFLECTION
# Now that the implementation is verified, capture accumulated knowledge:
#
# 1. "Now that I've built this, what would I have done differently?"
#    - Identify architectural choices that caused friction
#    - Note patterns that were harder to work with than expected
#    - Flag code that works but feels fragile or overly complex
#
# 2. "What should be refactored before moving on?"
#    - Concrete refactoring suggestions with file paths
#    - Technical debt introduced during implementation
#    - Opportunities to simplify or consolidate
#
# 3. "Did we over-build? Is there a simpler way?"
#    - Identify any added complexity that wasn't strictly needed
#    - Flag scope expansion beyond the original plan
#    - Check if any "fix everything encountered" items could have been simpler
#
# 4. "Would a staff engineer approve this?" (Principle #19)
#    - Check if the solution demonstrates good engineering taste
#    - Look for over-abstraction, unnecessary indirection, or "clever" code
#    - For non-trivial implementations: is there a more elegant approach?
#    - For simple fixes: skip this check - don't over-engineer obvious solutions
#
# Output reflection, then apply any low-risk refactors immediately.
# Log remaining suggestions in the plan document under "## Post-Build Reflection".
```

### Rules for the Loop Controller

| Rule | Meaning |
|------|---------|
| **NEVER output a final verdict while gaps discovered > 0** | Only a CLEAN zero-gap-from-start iteration produces the final report |
| **NEVER treat "found and fixed" as zero gaps** | Fixing during a pass still means gaps were discovered |
| **NEVER ask user "should I continue?"** | The loop is mandatory - just execute it |
| **NEVER stop after fixing gaps** | Fixing gaps requires a FRESH re-audit to verify the fixes |
| **ALWAYS use Task tool for verification passes** | Subagents keep context clean |
| **ALWAYS parse GAPS_DISCOVERED from result** | This is the loop control variable (DISCOVERED, not REMAINING) |
| **Maximum 10 iterations** | If still failing after 10, report to user with remaining gaps |
| **ALWAYS run multi-perspective review after implementation** | Multiple reviewers catch different issues than 1 auditor |
| **Run review subagents IN PARALLEL** | Security and architecture reviews are independent |
| **Fix CRITICAL/HIGH findings before verification** | Don't waste auditor passes on known issues |

### Why This Architecture Exists

**Incident #14**: Audit loop terminated after 1 pass with open gaps. Root cause: instructional "MUST loop" text competed with default "report and stop" behavior. By making the loop STRUCTURAL (spawn subagent, check result, loop), early termination becomes structurally impossible.

**Incident #19**: Auditor found 16 gaps and fixed all 16 in same pass, reported GAPS_FOUND: 0. Loop exited after 1 iteration without verifying fixes. GAPS_DISCOVERED (not GAPS_REMAINING) is the correct metric.

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
- Report in COMPLETION REPORT: "Checkpoint: preserved (loop incomplete -- max iterations reached)"

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

## GUARDRAIL CHECKS (Every Iteration)

### Mandatory Checks

```bash
# Pattern scanner (covers all pattern checks)
bash scripts/massu-pattern-scanner.sh
# Exit 0 = PASS, non-zero = ABORT iteration

# Security check
git diff --cached --name-only | grep -E '\.(env|pem|key|secret)' && echo "SECURITY VIOLATION" && exit 1
```

---

## ITERATION OUTPUT FORMAT

```markdown
## [CS LOOP - Iteration N]

### Task
Phase: X | Task: [description]

### Guardrails
- Pattern scanner: PASS/FAIL
- Security check: PASS/FAIL

### Verifications
| Check | Type | Result | Proof |
|-------|------|--------|-------|
| [item] | VR-FILE | PASS | `ls -la output` |

### Gap Count
Gaps found: N

### Status
CONTINUE | FIX_REQUIRED | CHECKPOINT | COMPLETE

### Next Action
[Specific next step]
```

---

## THE 10 ACCOUNTABILITY SAFEGUARDS

1. **Audit Proof Requirement** - Every claim MUST include proof output. Claims without proof are INVALID.
2. **Explicit Gap Count Per Loop** - State gaps found, gap details, status (PASS/FAIL). "Looks good" is BANNED.
3. **Checkpoint Sign-Off Format** - Use exact format from COMPLETION OUTPUT section.
4. **Session State Mandatory Updates** - Update `session-state/CURRENT.md` after EVERY change with proof.
5. **User Verification Rights** - User can request proof re-runs at any time. Comply with actual output.
6. **Post-Compaction Recovery** - Read session state FIRST, re-read plan, resume from exact point.
7. **No Claims Without Evidence** - "I verified...", "Build passed..." require accompanying proof output.
8. **Failure Acknowledgment** - Acknowledge failures, re-execute audit from Step 1, log in session state.
9. **No Workarounds Allowed** - TODOs, ts-ignore are BLOCKING violations. Pattern scanner is a HARD GATE.
10. **Document New Patterns** - If you discover a pattern not in CLAUDE.md, ADD IT NOW.

---

## SESSION STATE UPDATE (After Every Iteration)

Update `session-state/CURRENT.md` with: loop status (task, iteration, phase, checkpoint), iteration log table, verified work with proof, failed attempts (do not retry), next iteration plan.

---

## PLAN DOCUMENT COMPLETION TRACKING (MANDATORY)

Add completion table to TOP of plan document with status for each task:

```markdown
# IMPLEMENTATION STATUS

**Plan**: [Name] | **Status**: COMPLETE/IN_PROGRESS | **Last Updated**: [date]

| # | Task/Phase | Status | Verification | Date |
|---|------------|--------|--------------|------|
| 1 | [description] | 100% COMPLETE | VR-GREP: 0 refs | [date] |
```

### VR-PLAN-STATUS Verification

```bash
grep "IMPLEMENTATION STATUS" [plan_file]
grep -c "100% COMPLETE\|DONE\|\*\*DONE\*\*" [plan_file]
```

---

## STOP CONDITIONS (ALL must be true)

1. Every plan item verified complete (100%)
2. Pattern scanner: 0 violations (`bash scripts/massu-pattern-scanner.sh` exits 0)
3. Type check: 0 errors (`cd packages/core && npx tsc --noEmit` exits 0)
4. Tests: ALL pass (`npm test` exits 0)
5. Hook build: succeeds (`cd packages/core && npm run build:hooks` exits 0)
6. If new tools: VR-TOOL-REG passes (all 3 functions in tools.ts)

---

## CONTEXT MANAGEMENT

Use Task tool with subagents for exploration to keep main context clean. Update session state before compaction. After compaction, read session state and resume from correct step. Never mix unrelated tasks during a protocol.

---

## COMPLETION CRITERIA

CS Loop is COMPLETE **only when BOTH gates pass: Code Quality AND Plan Coverage**.

### GATE 1: Code Quality Verification (All Must Pass in SAME Audit Run)
- [ ] All phases executed, all checkpoints passed with zero gaps
- [ ] Pattern scanner: Exit 0
- [ ] Type check: 0 errors
- [ ] Build: Exit 0
- [ ] Tests: ALL PASS (MANDATORY)
- [ ] Security: No secrets staged

### GATE 2: Plan Coverage Verification
- [ ] Plan file read (actual file, not memory)
- [ ] ALL items extracted into tracking table
- [ ] EACH item verified with VR-* proof
- [ ] Coverage = 100% (99% = FAIL)
- [ ] Plan document updated with completion status

### DUAL VERIFICATION REQUIREMENT

**BOTH gates must pass:**

```markdown
## DUAL VERIFICATION RESULT
| Gate | Status | Details |
|------|--------|---------|
| Code Quality | PASS/FAIL | Pattern scanner, build, types |
| Plan Coverage | PASS/FAIL | X/Y items (Z%) |

**RESULT: COMPLETE** (only if both PASS)
```

**Code Quality: PASS + Plan Coverage: FAIL = NOT COMPLETE**

---

## COMPLETION OUTPUT

```markdown
## [CS LOOP - COMPLETE]

### Dual Verification Certification
- **Audit loops required**: N (loop #N achieved 0 gaps + 100% coverage)
- **Code Quality Gate**: PASS
- **Plan Coverage Gate**: PASS (X/X items = 100%)
- **CERTIFIED**: Both gates passed in single complete audit

### Summary
- Total iterations: N
- Total checkpoints: N (all PASSED)
- Final audit loop: #N - ZERO GAPS + 100% COVERAGE

### GATE 1: Code Quality Evidence
| Gate | Command | Result |
|------|---------|--------|
| Pattern scanner | `bash scripts/massu-pattern-scanner.sh` | Exit 0 |
| Type check | `cd packages/core && npx tsc --noEmit` | 0 errors |
| Build | `npm run build` | Exit 0 |
| Tests | `npm test` | All pass |

### GATE 2: Plan Coverage Evidence
| Item # | Description | Verification | Status |
|--------|-------------|--------------|--------|
| P1-001 | [description] | [VR-* output] | COMPLETE |
| ... | ... | ... | COMPLETE |

**Plan Coverage: X/X items (100%)**

### Plan Document Updated
- File: [path]
- Completion table: ADDED at TOP
- Plan Status: COMPLETE

### Session State
Updated: session-state/CURRENT.md
Status: COMPLETED
```

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state (CR-35)**

Before any other work, update `session-state/CURRENT.md` to include:
```
AUTHORIZED_COMMAND: massu-loop
```
This ensures that if the session compacts, the recovery protocol knows `/massu-loop` was authorized.

**Execute the LOOP CONTROLLER at the top of this file.**

### Phase 0: Pre-Implementation Memory Check
0. **Search memory** for failed attempts and known issues related to the plan's domain:
   - Check `.claude/session-state/CURRENT.md` for recent failures
   - If matches found: read the previous failures and avoid repeating them

### Phase 1: Implement
1. Load plan file from `$ARGUMENTS` (read from disk, not memory)
2. Extract ALL plan items into trackable checklist
3. Implement each item with VR-* proof
4. Update session state after each major step

### Phase 1.5: Multi-Perspective Review
5. Spawn security and architecture review subagents in parallel
6. Parse results and fix CRITICAL/HIGH findings before proceeding

### Phase 2: Verify (Subagent Loop)
7. Spawn `general-purpose` subagent (via Task tool) for verification iteration 1
8. Parse `GAPS_DISCOVERED` from the subagent result
9. If gaps > 0: fix what the auditor identified, spawn another iteration
10. If gaps == 0: output final completion report with dual gate evidence
11. Continue until zero gaps or maximum 10 iterations

### Phase 2.1: Post-Build Reflection
After verification passes with zero gaps, capture accumulated implementation knowledge before it's lost to context compression. Answer four questions:

1. **"Now that I've built this, what would I have done differently?"**
   - Architectural choices that caused friction
   - Patterns that were harder to work with than expected
   - Code that works but feels fragile or overly complex

2. **"What should be refactored before moving on?"**
   - Concrete suggestions with file paths and line numbers
   - Technical debt introduced during this implementation
   - Opportunities to simplify or consolidate

3. **"Did we over-build? Is there a simpler way?"**
   - Identify any added complexity that wasn't strictly needed
   - Flag scope expansion beyond the original plan
   - Check if any "fix everything encountered" items could have been simpler

4. **"Would a staff engineer approve this?" (Principle #19)**
   - Check if the solution demonstrates good engineering taste
   - Look for over-abstraction, unnecessary indirection, or "clever" code
   - For non-trivial implementations: is there a more elegant approach?
   - For simple fixes: skip this check - don't over-engineer obvious solutions

**Actions**:
- Apply any low-risk refactors immediately (re-run build/type check after)
- Log remaining suggestions in the plan document under `## Post-Build Reflection`

### Phase 3: Auto-Learning (MANDATORY)
12. **Execute AUTO-LEARNING PROTOCOL** before reporting completion

**The auditor subagent handles**: reading the plan, verifying all deliverables, checking patterns/build/types, fixing plan document gaps, and returning structured results.

**You (the loop controller) handle**: implementation, spawning auditors, parsing results, fixing code-level gaps, looping, learning, and documentation.

**Remember: Claims without proof are invalid. Show the verification output.**

---

## AUTO-LEARNING PROTOCOL (MANDATORY after every loop completion)

After Loop Completes (Zero Gaps):

- **Record fixes**: For each bug fixed, record the wrong vs correct pattern
- **Update pattern scanner**: If the bad pattern is grep-able, add detection to `scripts/massu-pattern-scanner.sh`
- **Codebase-wide search**: Verify no other instances of same bad pattern (CR-9)
- **Record user corrections**: If the user corrected any behavior during this loop, add structured entry to session state with date, wrong behavior, correction, and prevention rule

**A loop that fixes 5 bugs but records 0 learnings is 80% wasted. The fixes are temporary; the learnings are permanent.**
