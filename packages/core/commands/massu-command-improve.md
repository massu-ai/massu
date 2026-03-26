---
name: massu-command-improve
description: "When user wants to improve a specific command's quality score, says 'improve this command', 'fix command issues', or after command-health shows weak commands"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-command-improve

# Massu Command Improve: Score-Driven Prompt Optimization

## Purpose

Read accumulated command quality scores from `.claude/metrics/command-scores.jsonl`, identify consistently failing checks, propose **one targeted prompt edit at a time** to the command file, and wait for explicit user approval before applying.

**This is the manual-approval counterpart to autonomous autoresearch.** Scoring is automated; improvements require human judgment.

---

## ARGUMENTS

```
/massu-command-improve                    # Auto-pick weakest command
/massu-command-improve massu-debug         # Target specific command
```

**Arguments from $ARGUMENTS**: {{ARGUMENTS}}

---

## NON-NEGOTIABLE RULES

1. **ONE change per iteration** — never batch multiple edits. Single-variable perturbation only.
2. **ALWAYS show the exact diff** — user must see before/after text.
3. **NEVER apply without approval** — wait for explicit "yes", "approved", "apply it", etc.
4. **ALWAYS create backup** — save original section to `.claude/metrics/backups/[command]-v[N].md.bak` before editing.
5. **ALWAYS log the change** — append to `.claude/metrics/command-changelog.jsonl` after applying.
6. **Target the weakest check** — don't guess what to improve; let the data decide.

---

## EXECUTION STEPS

### Step 1: Load Score Data

Read `.claude/metrics/command-scores.jsonl`. If empty or missing:
```
No command scores recorded yet.
Scores accumulate automatically as you use instrumented commands:
  massu-article-review, massu-create-plan, massu-loop, massu-plan, massu-debug

Run these commands normally and come back when you have 5+ scored runs.
```

### Step 2: Analyze Weaknesses

For each command in the data:

1. Parse all JSONL lines for that command
2. Extract individual check pass/fail counts across all runs
3. Calculate per-check pass rate (e.g., `root_cause_identified`: 7/10 = 70%)
4. Identify the **single weakest check** (lowest pass rate)
5. Calculate overall command pass rate (average across all checks)

If `$ARGUMENTS` specifies a command, use that. Otherwise, auto-select the command with the lowest overall pass rate.

**Minimum data requirement**: At least 3 scored runs for the target command. If fewer:
```
[command] has only [N] scored runs. Need at least 3 for reliable analysis.
Keep using the command normally — scores accumulate automatically.
```

### Step 3: Diagnose the Failing Check

Read the target command file (`.claude/commands/[command].md`).

For the weakest check, analyze WHY it might be failing:

| Check Pattern | Likely Prompt Cause |
|--------------|---------------------|
| Check passes < 50% | The command doesn't mention this requirement at all, or buries it |
| Check passes 50-70% | The requirement exists but is vague or easy to skip |
| Check passes 70-85% | The requirement exists but lacks a concrete example or enforcement |
| Check passes > 85% | Healthy — move to next weakest check |

### Step 4: Propose ONE Edit

Design a single, targeted prompt edit that addresses the weakest check. The edit should be one of:

| Edit Type | When to Use | Example |
|-----------|-------------|---------|
| **Add explicit rule** | Check requirement is missing from prompt | "Your debug report MUST include a specific root cause statement, not 'probably' or 'might be'" |
| **Add worked example** | Check exists but is vague | Add a before/after example of what good looks like |
| **Promote to NON-NEGOTIABLE** | Check exists but is buried | Move the requirement higher in the file, add to the rules table |
| **Add enforcement step** | Check exists but is easy to skip | Add a numbered step to START NOW that explicitly requires this check |
| **Add banned pattern** | Check fails because of a specific anti-pattern | "NEVER produce a debug report without [X]" |

### Step 5: Present to User

Display:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMMAND IMPROVE — [command]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DATA SUMMARY
  Scored runs:     [N]
  Overall rate:    [X]%
  Date range:      [earliest] — [latest]

WEAKEST CHECK
  Name:            [check_name]
  Pass rate:       [X/N] ([Y]%)
  Diagnosis:       [why it's failing]

PROPOSED EDIT
  Type:            [Add rule / Add example / Promote / Add step / Ban pattern]
  Target section:  [which section of the command file]

  --- BEFORE ---
  [exact text being replaced or location of insertion]

  --- AFTER ---
  [exact new text]

  --- END DIFF ---

RATIONALE
  This targets [check_name] by [explanation of why this change should help].

APPROVE?
  Reply "yes" to apply, "skip" to move to next check, or "no" to stop.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Step 6: Wait for Approval

**STOP HERE. Do NOT proceed without explicit user approval.**

- **"yes" / "approved" / "apply it"** → proceed to Step 7
- **"skip"** → move to next weakest check on the same command, or next command
- **"no" / "stop"** → end the session, log the rejection

### Step 7: Apply Change

1. **Create backup**:
   - Check `.claude/metrics/backups/` exists (create if not)
   - Count existing backups for this command to determine version number
   - Save the ORIGINAL section (not whole file) to `.claude/metrics/backups/[command]-v[N].md.bak`

2. **Apply the edit** using the Edit tool

3. **Log the change** — append to `.claude/metrics/command-changelog.jsonl`:
```json
{"command":"[command]","timestamp":"ISO8601","action":"applied","target_check":"[check_name]","check_pass_rate_before":"[X/N]","edit_type":"[type]","edit_summary":"[1-line description]","backup_file":"[path]"}
```

4. **Confirm to user**:
```
Applied. Backup saved to [path].

Next time you run /[command], the scoring will capture whether this
change improved [check_name]. Check /massu-command-health after 3+ runs.
```

### Step 8: Continue or Stop

After applying (or skipping), offer to continue:
- If there are more weak checks on the same command (pass rate < 85%), offer to address the next one
- If the current command is healthy, offer to move to the next weakest command
- If all commands are above 85%, report "All commands healthy"

**Remember: ONE change at a time.** Even if 3 checks are weak, propose and apply them individually so you can measure each improvement's effect.

---

## REJECTION LOGGING

If the user rejects a proposal, log it so future runs don't re-propose the same thing:

```json
{"command":"[command]","timestamp":"ISO8601","action":"rejected","target_check":"[check_name]","edit_type":"[type]","edit_summary":"[1-line description]","rejection_reason":"[user's reason if given, or 'no reason provided']"}
```

Before proposing an edit, check the changelog for recent rejections of the same check+type combination. If found, try a DIFFERENT edit type for the same check.

---

## MEASURING IMPROVEMENT

After applying a change, the improvement is measured passively:

1. User continues using the command normally
2. Silent scoring appends new data to `command-scores.jsonl`
3. Next time `/massu-command-health` or `/massu-bearings` runs, the trend shows whether the check improved
4. Next time `/massu-command-improve` runs, it uses the updated data — if the check improved, it moves to the next weakest

The feedback loop:
```
Score → Diagnose → Propose → Approve → Apply → Score again → ...
```

---

## EDGE CASES

- **No JSONL file**: Tell user to use instrumented commands first
- **< 3 runs for target command**: Tell user to accumulate more data
- **All checks > 85%**: "All commands healthy — no improvements needed"
- **User specifies unknown command**: List the 5 instrumented commands
- **Changelog shows same check was improved before**: Note this in the proposal ("Previously improved on [date] — may need a different approach")

---

## START NOW

1. Read `.claude/metrics/command-scores.jsonl`
2. If `$ARGUMENTS` specifies a command, target that; otherwise auto-pick weakest
3. Analyze per-check pass rates
4. Identify weakest check
5. Read the command file
6. Diagnose why the check fails
7. Propose ONE targeted edit with exact diff
8. **WAIT for user approval**
9. If approved: backup → apply → log → confirm
10. Offer to continue with next weak check

---

## Related Commands

- `/massu-autoresearch [command]` — Autonomous version. Runs the optimize loop unattended with git-based accept/reject. Use for overnight runs.
- `/massu-command-health` — Read-only dashboard. Shows scores, trends, and weakest checks.
