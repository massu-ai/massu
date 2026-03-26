# Competitive Mode Protocol

> Reference doc for `/massu-golden-path --competitive`. Return to main file for overview.

**Purpose**: Spawn 2-3 competing implementations of the same plan with different optimization biases, score all implementations, and select the winner before proceeding with Massu's verification rigor.

**Triggering**: Only when `/massu-golden-path --competitive` is explicitly used. Never automatic.

---

## Pre-Flight Guard (MANDATORY)

Before spawning agents, scan the plan for database migration items:

```
SCAN plan for:
  - Items with type = MIGRATION
  - Items containing ALTER TABLE, CREATE TABLE, DROP TABLE
  - Items containing RLS policies or grants
  - Items referencing database migrations

IF any found:
  ABORT competitive mode with message:
  "Competitive mode cannot run plans with database migrations.
   Apply migrations first, then re-run with --competitive."
```

This mirrors the `/massu-batch` DB guard pattern (`scripts/batch-db-guard.sh`).

---

## Phase 2-COMP-A: Agent Spawning

### Determine Agent Count & Bias Assignments

| Flag | Agents | Bias Assignments |
|------|--------|-----------------|
| `--competitive` (default) | 2 | `quality` + `robust` |
| `--competitive --agents 3` | 3 | `quality` + `ux` + `robust` |
| `--competitive --biases quality,ux` | 2 | Custom assignment |

### Spawn Agents

For each agent, spawn using worktree isolation:

```
FOR each agent (A, B, [C]):
  Agent(
    isolation: "worktree",
    prompt: [See Phase 2-COMP-B template],
    model: "opus"
  )
```

All agents spawn in PARALLEL. Each gets an isolated git worktree branch.

---

## Phase 2-COMP-B: Agent Prompt Template

Each competing agent receives this prompt, customized with their bias preset:

```
You are implementing a plan in competitive mode. Your implementation will be
scored against other agents implementing the same plan with different priorities.

PLAN FILE: {plan_path}
YOUR BIAS: {bias_preset}
YOUR BRANCH: {worktree_branch}

BIAS INSTRUCTIONS:
{bias_prompt_fragment}

IMPLEMENTATION RULES:
1. Read the plan from disk and implement ALL items
2. Follow ALL CLAUDE.md patterns (ctx.db, protectedProcedure, etc.)
3. Do NOT run database migrations (handled separately)
4. Run pattern-scanner after each file: ./scripts/pattern-scanner.sh
5. Run tsc after implementation: npx tsc --noEmit
6. Fix any issues before declaring done

OUTPUT FORMAT (at completion):
```
COMPETITIVE_AGENT_RESULT:
  BIAS: {bias}
  BRANCH: {branch}
  STATUS: COMPLETE | FAILED
  FILES_CHANGED: [list]
  SELF_SCORE:
    code_clarity: X/5
    pattern_compliance: X/5
    error_handling: X/5
    ux_quality: X/5
    test_coverage: X/5
  NOTES: [key decisions, trade-offs made]
  ERROR: [if failed, what went wrong]
```
```

---

## Phase 2-COMP-B.1: Bias Preset Definitions

### Quality Bias
```
YOUR OPTIMIZATION PRIORITY: CODE QUALITY

Focus on:
- Crystal-clear naming for all variables, functions, and components
- Consistent code structure following established patterns exactly
- Minimal complexity — prefer simple, readable solutions over clever ones
- Strong typing with meaningful type names
- Functions under 50 lines, files under 500 lines
- Comments only where logic is non-obvious

When in doubt between two approaches, choose the one that is easier to read
and maintain, even if the alternative has slightly better performance or
handles one more edge case.
```

### UX Bias
```
YOUR OPTIMIZATION PRIORITY: USER EXPERIENCE

Focus on:
- Loading states with skeletons for every async operation
- Error states with clear messages and recovery actions
- Empty states with helpful guidance
- Responsive design across mobile, tablet, and desktop
- Accessibility: aria labels, keyboard navigation, focus management
- Dark mode support with proper contrast
- Smooth transitions and micro-interactions
- Toast notifications for all user actions (success, error, info)

When in doubt between two approaches, choose the one that provides the
better user experience, even if it requires slightly more code.
```

### Robust Bias
```
YOUR OPTIMIZATION PRIORITY: ROBUSTNESS & ERROR HANDLING

Focus on:
- Comprehensive input validation at every boundary
- Try/catch around all async operations with specific error messages
- Null/undefined guards for all optional data
- Edge cases: empty arrays, single items, maximum values, concurrent access
- Defensive coding: never trust external input, always validate
- Graceful degradation when services are unavailable
- Proper error propagation with context

When in doubt between two approaches, choose the one that handles more
failure modes, even if it requires slightly more code or complexity.
```

---

## Phase 2-COMP-C: Monitoring & Collection

```
WAIT for all agents to complete

FOR each agent result:
  PARSE COMPETITIVE_AGENT_RESULT from output
  IF STATUS == FAILED:
    INCREMENT failure_count
    LOG failure details

IF failure_count == total_agents:
  ABORT with total failure error (see error-handling.md)
ELSE IF failure_count > 0:
  LOG: "{failure_count} agent(s) failed, continuing with {remaining} successful"
  CONTINUE with successful agents only
ELSE:
  ALL agents completed successfully
```

---

## Phase 2-COMP-D: Scoring & Comparison

Spawn the `massu-competitive-scorer` agent:

```
Task(
  subagent_type: "massu-competitive-scorer",
  model: "opus",
  prompt: "
    Score and compare competing implementations.
    Plan: {plan_path}
    Branches: {list of successful worktree branches}
    Bias assignments: {map of branch -> bias}

    Execute your full scoring workflow and return the structured comparison.
  "
)
```

Parse the scorer output for:
- `WINNER`: branch name
- `WINNER_BIAS`: bias preset
- `WINNER_SCORE`: weighted total
- `RUNNER_UP`: branch name
- `RUNNER_UP_SCORE`: weighted total
- `SCORE_MARGIN`: difference

---

## Phase 2-COMP-E: Winner Selection

**APPROVAL POINT #5: WINNER SELECTION**

Present the scorer's comparative scorecard to the user. See `approval-points.md` for exact format.

### After Approval

| User Response | Action |
|---------------|--------|
| `approve` | Accept recommended winner, proceed to Phase 2-COMP-F |
| `override [agent_id]` | Select the specified agent as winner instead |
| `abort` | Stop golden path, leave worktrees for inspection |

---

## Phase 2-COMP-F: Winner Merge

### Merge Winning Branch

```
1. Identify winning worktree branch
2. git merge {winning_branch} --no-ff -m "competitive-mode: merge winner ({bias})"
3. IF merge conflict:
     Present to user for resolution (see error-handling.md)
4. ELSE:
     Merge successful
```

### Cleanup Losing Worktrees

```
FOR each non-winning worktree:
  git worktree remove {path} --force
  git branch -D {branch_name}

IF cleanup fails:
  Log warning (non-blocking, see error-handling.md)
```

### Post-Merge Verification

```
1. Run ./scripts/pattern-scanner.sh (exit 0 required)
2. Run npx tsc --noEmit (0 errors required)
3. IF either fails:
     Fix issues from merge
     Re-run verification
```

### Continue to Phase 2.5

After successful merge and verification, proceed directly to Phase 2.5 (Gap & Enhancement Analysis). The winner's implementation is now on the current branch and all subsequent phases (2.5, 3, 4, 5, 6) run normally.

---

## Cost Implications

| Mode | Phase 2 Token Multiplier | When to Use |
|------|-------------------------|-------------|
| Standard (no flag) | 1x | Most features, incremental changes |
| `--competitive` (2 agents) | ~2.2x | New modules, critical features, UI-heavy work |
| `--competitive --agents 3` | ~3.3x | High-stakes features, new domain areas |

The multiplier applies ONLY to Phase 2 (implementation). All other phases run once regardless.
