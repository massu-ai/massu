# Loop Controller

> Reference doc for `/massu-loop`. Return to main file for overview.

## MANDATORY LOOP CONTROLLER (EXECUTE THIS - DO NOT SKIP)

**This section is the EXECUTION ENTRY POINT. You MUST follow these steps exactly.**

### How This Command Works

This command is a **loop controller** for implementation + verification. Your job is to:
1. Extract plan items and implement them
2. After implementation, spawn a `massu-plan-auditor` subagent for verification
3. Parse the structured result (`GAPS_DISCOVERED: N`)
4. If gaps discovered > 0: fix gaps, then spawn ANOTHER FRESH auditor pass
5. Only when a COMPLETE FRESH PASS discovers ZERO gaps can you declare complete

**The verification audit runs inside Task subagents. This prevents early termination.**

### CRITICAL: GAPS_DISCOVERED Semantics (Incident #19, Feb 7, 2026)

**`GAPS_DISCOVERED` = total gaps FOUND during the pass, REGARDLESS of whether they were also fixed.**

| Scenario | GAPS_DISCOVERED | Loop Action |
|----------|----------------|-------------|
| Pass finds 0 gaps | 0 | **EXIT** - verification complete |
| Pass finds 5 gaps, fixes all 5 | **5** (NOT 0) | **CONTINUE** - must re-verify |
| Pass finds 3 gaps, fixes 1, 2 need controller | **3** | **CONTINUE** - fix remaining, re-verify |

**THE RULE**: A clean pass means zero gaps DISCOVERED from the start. Fixing gaps during a pass does NOT make it a clean pass. The fixes themselves could introduce new issues. Only a fresh pass starting clean and finding nothing proves correctness.

### Execution Protocol

```
PLAN_PATH = $ARGUMENTS (the plan file path or task description)
iteration = 0

# Phase 1: IMPLEMENT (do the work)
# Read plan, extract items, implement each one with VR-* proof

# Phase 1.5: MULTI-PERSPECTIVE REVIEW (after implementation, before verification)
# Spawn 3 focused review subagents IN PARALLEL for independent analysis
# Each reviewer has an adversarial mindset and a SINGLE focused concern (Principle #20)
# Elegance/simplicity assessment happens in Phase 2.1 POST-BUILD REFLECTION (Q4)

security_result = Task(subagent_type="massu-security-reviewer", model="opus", prompt="
  Review implementation for plan: {PLAN_PATH}
  Focus: Security vulnerabilities, auth gaps, input validation, data exposure
  Check all new/modified files. Return structured result with SECURITY_GATE.
")

architecture_result = Task(subagent_type="massu-architecture-reviewer", model="opus", prompt="
  Review implementation for plan: {PLAN_PATH}
  Focus: Design issues, coupling problems, pattern compliance, scalability
  Check all new/modified files. Return structured result with ARCHITECTURE_GATE.
")

ux_result = Task(subagent_type="massu-ux-reviewer", model="sonnet", prompt="
  Review implementation for plan: {PLAN_PATH}
  Focus: User experience, accessibility, loading/error/empty states, consistency
  Check all new/modified UI files. Return structured result with UX_GATE.
")

# Parse results and fix any CRITICAL/HIGH findings before proceeding to verification
# FAIL gate = must fix before proceeding
# WARN findings = document and proceed

# Phase 1.6: TEST-FIRST FOR CRITICAL FINDINGS
# If ANY Phase 1.5 reviewer flagged a CRITICAL-severity BUG (not pattern violation):
#   1. Read _shared-references/test-first-protocol.md
#   2. For EACH critical bug finding:
#      - Write a failing test that demonstrates the bug (Step 1)
#      - Verify the test fails for the expected reason (Step 2)
#      - Apply the fix (Step 3)
#      - Verify the test passes (Step 4)
#   3. Report TEST_FIRST_GATE: PASS or SKIPPED (with reason)
# If NO critical bug findings: skip this phase entirely

# Phase 2: VERIFY (audit loop - STRUCTURAL)
WHILE true:
  iteration += 1

  # Run circuit breaker check (CR-37: detect stagnation)
  bash scripts/hooks/loop-circuit-breaker.sh --pass {iteration} --plan-trajectory .claude/loop-state/plan-trajectory.json
  # Parse circuit breaker output - BAIL_AND_REPLAN is a structural halt
  IF CIRCUIT_BREAKER_STATUS == "DEPTH_EXCEEDED":
    Output: "CIRCUIT BREAKER: Loop depth exceeded (nested spawn detected)."
    Output: "Current LOOP_DEPTH exceeds MAX_LOOP_DEPTH. Refusing to continue."
    STOP loop immediately — cascade prevention.

  IF CIRCUIT_BREAKER_STATUS == "BAIL_AND_REPLAN":
    Output: "CIRCUIT BREAKER: The current approach is not converging after {iteration} passes."
    Output: "No progress: {no_progress_count} passes | Same errors: {same_error_count} passes"
    Output: "Options: (a) Re-plan with different approach (b) Continue current approach (c) Stop"
    AskUserQuestion: "The loop has stalled. How should we proceed?"
    IF user chooses re-plan: STOP loop, output current state, recommend /massu-create-plan
    IF user chooses continue: CONTINUE loop (reset circuit breaker: bash scripts/hooks/loop-circuit-breaker.sh --reset)
    IF user chooses stop: STOP loop, output current state as incomplete

  IF CIRCUIT_BREAKER_STATUS == "PLAN_FUNDAMENTALLY_WRONG":
    Output: "CIRCUIT BREAKER: Plan is fundamentally wrong — {distinct_failures} different items have failed."
    Output: "This indicates a systemic plan issue, not isolated implementation problems."
    Output: "Options:"
    Output: "  (a) DISPOSE plan and regenerate from scratch (preserves learnings)"
    Output: "  (b) Continue with current plan (override)"
    Output: "  (c) Stop and review manually"
    AskUserQuestion: "The plan appears fundamentally flawed. How should we proceed?"
    IF user chooses dispose:
      - Save failed items + error context to plan trajectory file
      - STOP loop, output current state
      - Recommend: /massu-create-plan with failed items as constraints
      - The NEW plan goes through the same zero-gaps audit loop before implementation
    IF user chooses continue: CONTINUE loop (reset: bash scripts/hooks/loop-circuit-breaker.sh --reset)
    IF user chooses stop: STOP loop, output current state as incomplete

  # Spawn auditor subagent for ONE complete verification pass
  result = Task(subagent_type="massu-plan-auditor", model="opus", prompt="
    Audit iteration {iteration} for plan: {PLAN_PATH}
    Execute ONE complete audit pass. Verify ALL deliverables.
    Check code quality (patterns, build, types, tests).
    Check plan coverage (every item verified with proof).
    Fix any gaps you find (code or plan document).

    CRITICAL INSTRUCTION FOR GAPS_DISCOVERED:
    Report GAPS_DISCOVERED as the total number of gaps you FOUND during this pass,
    EVEN IF you also fixed them. Finding 5 gaps and fixing all 5 = GAPS_DISCOVERED: 5.
    A clean pass that finds nothing wrong from the start = GAPS_DISCOVERED: 0.
    Do NOT report 0 just because you fixed everything. The loop controller needs to know
    whether this was a clean pass (found nothing) or a dirty pass (found and fixed things).

    Return the structured result block with GAPS_DISCOVERED (not GAPS_FOUND).
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
| **ALWAYS run multi-perspective review after implementation** | 3 reviewers catch different issues than 1 auditor |
| **Run review subagents IN PARALLEL** | Security, architecture, UX reviews are independent |
| **Fix CRITICAL/HIGH findings before verification** | Don't waste auditor passes on known issues |
| **VR-PIPELINE for data features (CR-43)** | After implementing any data pipeline (AI, cron, generation, ETL), trigger it manually and verify non-empty output before marking complete |

### Why This Architecture Exists

**Incident #14 (Jan 30, 2026)**: Audit loop terminated after 1 pass with 6 open gaps. User had to manually intervene. Root cause: instructional "MUST loop" text competed with default "report and stop" behavior. By making the loop STRUCTURAL (spawn subagent, check result, loop), early termination becomes structurally impossible.

**Incident #19 (Feb 7, 2026)**: Auditor found 16 gaps and fixed all 16 in the same pass, reported GAPS_FOUND: 0. Loop exited after 1 iteration without verifying the fixes. GAPS_DISCOVERED (not GAPS_REMAINING) is the correct metric.

---

### Subagent Budget Discipline

The loop controller (main agent) coordinates; subagents execute scoped work. Follow these principles to prevent subagent sprawl:

| Principle | Meaning |
|-----------|---------|
| **One task per subagent** | Each Task call has a single, scoped objective (Principle #20) |
| **Main agent fixes, subagent verifies** | Controller fixes code-level gaps; auditor subagent re-verifies |
| **No nested spawns** | Subagents NEVER spawn their own subagents (circuit breaker enforces via LOOP_DEPTH) |
| **Parallel only when independent** | Review agents (security, architecture, UX) run in parallel; sequential passes run sequentially |
| **Budget awareness** | Each subagent pass costs ~20-40K tokens. 10 iterations = significant cost. Fix root causes, not symptoms |
