# Error Handling

> Reference doc for `/massu-golden-path`. Return to main file for overview.

## Recoverable Errors

Fix automatically -> re-run failed step -> if fixed, continue without pausing -> if not fixable after 3 attempts, pause and report.

## Non-Recoverable Errors

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

## Abort Handling

When user says "abort" at any approval point:

```
===============================================================================
GOLDEN PATH ABORTED
===============================================================================

Stopped at: [Phase N -- Approval Point]

CURRENT STATE:
  Completed phases: [list]
  Pending phases: [list]
  Plan file: [path]
  Files changed: [list]
  Commit created: YES/NO
  Pushed: NO

TO RESUME:
  Run /massu-golden-path again with the same plan
  Or run individual commands:
    /massu-loop      -- Continue implementation
    /massu-simplify  -- Run quality analysis
    /massu-commit    -- Run commit verification
    /massu-push      -- Run push verification

===============================================================================
```

---

## Post-Compaction Re-Verification (CR-42)

**After ANY context compaction during a golden path run**, BEFORE continuing implementation:

1. **Re-read the FULL plan document** from disk (CR-5 -- never from memory)
2. **Diff every completed item against actual code**: For each item marked complete in the tracking table, re-run its VR-* verification command
3. **VR-SPEC-MATCH audit**: For every completed UI item with specific CSS classes/structure in the plan, grep for those EXACT strings in the implementation
4. **Flag mismatches**: Any item where implementation doesn't match the plan's exact spec -> mark as gap, fix before continuing

This prevents the common failure mode where compaction loses spec details and the agent continues implementing without matching the plan's precise requirements.

---

## Competitive Mode Errors (--competitive only)

### Agent Failure During Implementation

**Partial failure** (1 agent fails, 2+ remain): Continue with remaining agents. Log the failure. Score only the successful implementations.

**Total failure** (all agents fail):
```
===============================================================================
GOLDEN PATH BLOCKED
===============================================================================

BLOCKER: All competing agents failed during Phase 2-COMP
  Agent A ({bias_a}): [error summary]
  Agent B ({bias_b}): [error summary]

Required: Fix the underlying issue, then re-run /massu-golden-path --competitive
  Or run without --competitive to use standard single-agent implementation.

===============================================================================
```

### Merge Conflict When Applying Winner

If the winning worktree branch cannot be cleanly merged:
```
===============================================================================
GOLDEN PATH BLOCKED
===============================================================================

BLOCKER: Merge conflict when applying winner (Agent {X})
Conflicting files: [list]

Required: Resolve conflicts manually, then continue with Phase 2.5
  Or select a different winner: "override [agent_id]"

===============================================================================
```

### Scoring Tie

If two or more agents have weighted scores within 0.5 of each other, flag as TIE and present to user for decision via the Winner Selection approval point. The scorer will note `SCORE_MARGIN: < 0.5 (TIE)` and the user must use `override [agent_id]` to select.

### Worktree Cleanup Failure

If worktree cleanup fails after winner selection:
```
Warning: Failed to clean up worktree branches. Manual cleanup:
  git worktree remove [path] --force
  git branch -D [branch_name]
```
This is non-blocking — continue with the golden path.
