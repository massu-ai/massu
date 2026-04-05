# Loop Controller

> Reference doc for `/massu-loop`. Return to main file for overview.

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

### CRITICAL: GAPS_DISCOVERED Semantics (Incident #19)

**`GAPS_DISCOVERED` = total gaps FOUND during the pass, REGARDLESS of whether they were also fixed.**

| Scenario | GAPS_DISCOVERED | Loop Action |
|----------|----------------|-------------|
| Pass finds 0 gaps | 0 | **EXIT** - verification complete |
| Pass finds 5 gaps, fixes all 5 | **5** (NOT 0) | **CONTINUE** - must re-verify |
| Pass finds 3 gaps, fixes 1, 2 need controller | **3** | **CONTINUE** - fix remaining, re-verify |

**THE RULE**: A clean pass means zero gaps DISCOVERED from the start. Fixing gaps during a pass does NOT make it a clean pass. The fixes themselves could introduce new issues. Only a fresh pass starting clean and finding nothing proves correctness.

### Agent Result Persistence

All Task sub-agents MUST write their results to disk in addition to returning text:
- Security review: `.massu/agent-results/{timestamp}-security.json`
- Architecture review: `.massu/agent-results/{timestamp}-architecture.json`
- Verification audit: `.massu/agent-results/{timestamp}-verify-{iteration}.json`

JSON format: `{ iteration, gaps_discovered, gaps_fixed, gaps_remaining, plan_items_total, plan_items_verified, findings: [] }`

This prevents context overflow from killing verification progress. If the parent session crashes, a new session can read these files via `bash scripts/hooks/read-agent-results.sh` to resume.

### Workflow State Tracking

At the start of this command, write a transition entry to `.massu/workflow-log.md`:
```
| [timestamp] | AUDIT/PLAN | IMPLEMENT | /massu-loop | [session-id] |
```

At completion, write a completion entry.

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

# Parse results and fix ALL findings at ALL severity levels (CR-45)
# CRITICAL, HIGH, MEDIUM, LOW — all get fixed before proceeding
# No severity is exempt — "clean pass" means ZERO findings

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
    Do NOT report 0 just because you fixed everything. The loop controller needs to know
    whether this was a clean pass (found nothing) or a dirty pass (found and fixed things).

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

# Phase 2.1: POST-BUILD REFLECTION + MANDATORY MEMORY PERSIST (CR-38)
# See references/auto-learning.md for full protocol
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

**Incident #19**: Auditor found 16 gaps and fixed all 16 in the same pass, reported GAPS_FOUND: 0. Loop exited after 1 iteration without verifying the fixes. GAPS_DISCOVERED (not GAPS_REMAINING) is the correct metric.

---

### Subagent Budget Discipline

The loop controller (main agent) coordinates; subagents execute scoped work. Follow these principles to prevent subagent sprawl:

| Principle | Meaning |
|-----------|---------|
| **One task per subagent** | Each Task call has a single, scoped objective (Principle #20) |
| **Main agent fixes, subagent verifies** | Controller fixes code-level gaps; auditor subagent re-verifies |
| **No nested spawns** | Subagents NEVER spawn their own subagents |
| **Parallel only when independent** | Review agents (security, architecture) run in parallel; sequential passes run sequentially |
| **Budget awareness** | Each subagent pass costs ~20-40K tokens. 10 iterations = significant cost. Fix root causes, not symptoms |
