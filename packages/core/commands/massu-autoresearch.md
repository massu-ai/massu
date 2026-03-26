---
name: massu-autoresearch
description: "When user wants autonomous command optimization, says 'autoresearch', 'optimize this command', 'run overnight improvement loop', or wants Karpathy-style iterative prompt optimization"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), Agent(*), Task(*)
---
name: massu-autoresearch

**Shared rules**: Read `.claude/commands/_shared-preamble.md` for POST-COMPACTION (CR-12), ENTERPRISE-GRADE (CR-14), AWS SECRETS (CR-5) rules.

# Massu Autoresearch: Autonomous Command Optimization Loop

## Objective

Iteratively improve a target command file by scoring output against an eval checklist, keeping improvements (git commit), reverting failures (git checkout), and repeating until convergence. Based on Karpathy's autoresearch pattern (42K GitHub stars).

---

## ARGUMENTS

```
/massu-autoresearch [command-name]                    # Default: 20 iterations, 90% target
/massu-autoresearch [command-name] --max-iterations N # Custom iteration cap
/massu-autoresearch [command-name] --target-score N   # Custom target (default 90)
/massu-autoresearch [command-name] --no-limit         # NEVER STOP mode (cost cap only)
```

**Arguments from $ARGUMENTS**: {{ARGUMENTS}}

---

## THREE-FILE ARCHITECTURE

| Role | File | Mutable? |
|------|------|----------|
| **Target** (train.py) | `.claude/commands/[command].md` (or `[command]/[command].md` for folder-based) | YES — agent edits this |
| **Eval** (prepare.py) | `.claude/evals/[command].md` | **NO — IMMUTABLE** |
| **Instructions** (program.md) | This file | **NO — agent follows this** |

The target command is the ONLY file the agent may edit. The eval checklist and these instructions are READ-ONLY.

---

## NON-NEGOTIABLE RULES

1. **ONE change per iteration** — single-variable perturbation only. Never batch multiple edits.
2. **NEVER edit the eval file** — `.claude/evals/[command].md` is immutable during runs.
3. **NEVER edit lines containing CR-*/VR-* references** — these encode incident-learned safety rules. See `references/safety-rails.md` for protected line patterns.
4. **ALWAYS backup before first iteration** — save original to `.claude/metrics/backups/[command]-autoresearch-[timestamp].md.bak`
5. **git commit on improvement / git checkout on regression** — tristate handling (see below).
6. **Tristate results**: KEEP / DISCARD / CRASH — crashes do NOT count toward stagnation.
7. **NEVER STOP mode** (when `--no-limit` passed): "Once the experiment loop has begun, do NOT pause to ask the human if you should continue." Run until convergence, cost cap (500K tokens), or manual interrupt (Ctrl+C). Default mode uses `--max-iterations` cap.

---

## TRISTATE RESULTS

Every iteration produces one of three outcomes:

| Outcome | Condition | Action |
|---------|-----------|--------|
| **KEEP** | `score_after > score_before` AND passes simplicity gate | `git add [target] && git commit -m "autoresearch([cmd]): [summary]"` — new baseline |
| **DISCARD** | `score_after <= score_before` OR fails simplicity gate | `git checkout -- [target]` — revert to baseline |
| **CRASH** | Eval subagent errored or produced unparseable output | Log the crash. Do NOT count toward stagnation. Retry once with simplified edit. If still failing, count as DISCARD. |

Crash handling details: see `references/safety-rails.md`.

---

## SIMPLICITY CRITERION

Apply the simplicity gate per `references/scoring-protocol.md`. Key principle (Karpathy): "Marginal improvement + added complexity = reject. Improvement from deleting code = definitely keep."

---

## "THINK HARDER" GRADUATED ESCALATION

Replaces CR-37 immediate bail. When stuck, escalate before giving up. Consecutive revert counter resets to 0 after any KEEP.

| Level | Trigger |
|-------|---------|
| **Level 1** | 3 consecutive reverts |
| **Level 2** | 5 consecutive reverts |
| **Level 3** | 8 consecutive reverts |
| **BAIL** | 10 consecutive reverts |

Per-level strategies: see `references/safety-rails.md`.

---

## CONVERGENCE CRITERIA

The loop stops when ANY of these conditions is met:

| Condition | Default | Overridable? |
|-----------|---------|-------------|
| Score >= target for 3 consecutive iterations | 90% | `--target-score N` |
| Max iterations reached | 20 | `--max-iterations N` or `--no-limit` |
| Stagnation bail (10 consecutive reverts after Level 3) | Always active | Not overridable |
| Cost cap (estimated cumulative token usage) | 500K tokens | Not overridable |

---

## LOOP CONTROLLER

### Initialization (runs once)

1. **Parse arguments**: Extract command name, max iterations, target score, no-limit flag
2. **Validate files exist**:
   - Target: `.claude/commands/[command].md` (or `.claude/commands/[command]/[command].md` for folder-based)
   - Eval: `.claude/evals/[command].md`
   - Fixture: `.claude/evals/fixtures/[command]/input-01.md`
3. **Resolve target path**: Determine actual file — `.claude/commands/[command].md` (flat) or `.claude/commands/[command]/[command].md` (folder-based). Store as `TARGET_PATH` for all git operations.
4. **Create git branch**: `git checkout -b autoresearch/[command]-[YYYY-MM-DD]` (if exists, append `-2`, `-3`, etc.)
5. **Create backup**: Copy target to `.claude/metrics/backups/[command]-autoresearch-[timestamp].md.bak`
6. **Measure baseline**: Run eval 3 times, take median score. Log as `"iteration":0` in `autoresearch-runs.jsonl`
7. **Initialize state**: `consecutive_reverts = 0`, `escalation_level = 0`, `cumulative_kept = 0`, `cumulative_discarded = 0`, `cumulative_crashed = 0`, `cumulative_rejected = 0`

### Per-Iteration Loop

For each iteration `i` from 1 to max_iterations (or unlimited if `--no-limit`):

**Step 1: Read current state**
- Read target command file (current version after any prior keeps)
- Read eval checklist (immutable)
- Read fixture input
- Review failing checks from previous iteration (or baseline)

**Step 2: Hypothesize improvement**
Based on failing checks and escalation level, choose ONE edit:
- What check are we targeting?
- What edit type? (add rule, add example, restructure, promote, ban pattern)
- What specific change? (exact text to add/modify)

**Step 3: Apply edit**
- Use Edit tool to make ONE change to the target file
- Count lines added and removed

**Step 4: Run eval**
Read `references/eval-runner.md` for the eval subagent protocol.

Spawn an eval subagent with:
- The CURRENT target command text (after edit)
- The eval checklist
- The fixture input

Extract: score percentage, per-check results, failing check names.

**Step 5: Score and decide**
- Compare `score_after` to `score_before` (baseline or last kept score)
- Apply simplicity criterion
- Determine outcome: KEEP, DISCARD, CRASH, or REJECTED_COMPLEXITY

**Step 6: Act on decision**

| Decision | Git Action | State Update |
|----------|-----------|--------------|
| KEEP | `git add [target] && git commit` | `score_before = score_after`, `consecutive_reverts = 0`, `cumulative_kept += 1` |
| DISCARD | `git checkout -- [target]` | `consecutive_reverts += 1`, `cumulative_discarded += 1` |
| CRASH | Log crash, retry once simplified | `cumulative_crashed += 1` (consecutive_reverts unchanged) |
| REJECTED_COMPLEXITY | `git checkout -- [target]` | `consecutive_reverts += 1`, `cumulative_rejected += 1` |

**Step 7: Log iteration**
Append to `.claude/metrics/autoresearch-runs.jsonl`. See `references/scoring-protocol.md` for format.

**Step 8: Check convergence**
- If score >= target for 3 consecutive scored iterations (KEEP or DISCARD, not CRASH): CONVERGED — exit loop. If baseline already >= target, run 3 verification iterations to confirm before converging.
- If consecutive_reverts triggers escalation level change: log escalation
- If consecutive_reverts >= 10 (after Level 3): STAGNATION — exit loop
- If max iterations reached: MAX_ITERATIONS — exit loop

**Step 9: Update session state**
Update `session-state/CURRENT.md` with current iteration count, score, and status.

**Step 10: Continue**
Return to Step 1.

---

## FINAL REPORT

After the loop exits (any reason), produce:

```
AUTORESEARCH COMPLETE — [command]

  Reason:           [CONVERGED / MAX_ITERATIONS / STAGNATION / COST_CAP]
  Iterations:       [N]
  Branch:           autoresearch/[command]-[date]

  Score Progression:
    Baseline:       [X]% ([N/M] checks)
    Final:          [Y]% ([N/M] checks)
    Delta:          [+/-Z]%

  Results:
    Kept:           [N] commits
    Discarded:      [N] reverts
    Crashed:        [N] transient failures
    Rejected:       [N] complexity rejections

  Net Lines:        [+/-N] across all kept changes
  Highest Escalation: Level [0-3]

  Kept Changes:
    1. [iteration N] [edit summary] (+X checks)
    2. [iteration N] [edit summary] (+X checks)
    ...

  Still Failing:
    - [check_name]: [brief description of why it's hard]
    ...

  Next Steps:
    - Review changes: git log autoresearch/[command]-[date]
    - Merge if satisfied: git merge autoresearch/[command]-[date]
    - Or cherry-pick specific commits
```

---

## SESSION STATE

Update `session-state/CURRENT.md` after each iteration:

```
AUTHORIZED_COMMAND: massu-autoresearch
Target: [command]
Branch: autoresearch/[command]-[date]
Iteration: [N]/[max]
Current Score: [X]%
Consecutive Reverts: [N]
Escalation Level: [0-3]
```

---

## Skill Contents

This skill is a folder. The following files are available for reference:

| File | Purpose | Read When |
|------|---------|-----------|
| `references/eval-runner.md` | Eval subagent spawn protocol | Before running any eval |
| `references/safety-rails.md` | Protected lines, backup, branch, cost cap, crash handling, escalation | Before any edit or on error |
| `references/scoring-protocol.md` | Score calculation, accept/reject, JSONL format, final summary | Before scoring or logging |

---

## START NOW

1. Parse `{{ARGUMENTS}}` for command name, flags
2. Validate target + eval + fixture exist
3. Create branch `autoresearch/[command]-[date]`
4. Backup target file
5. Measure baseline (3 eval runs, median)
6. Enter iteration loop
7. On exit: produce final report
8. **DO NOT ask "should I continue?" between iterations — just continue.**
