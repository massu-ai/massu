---
name: massu-ci-fix
description: "When CI fails after push — auto-diagnoses failures, fixes, commits, and re-pushes. 'ci fix', 'fix ci', 'ci failed', 'workflow failed'"
allowed-tools: Bash(*), Read(*), Edit(*), Write(*), Grep(*), Glob(*)
---
name: massu-ci-fix

# Massu CI Fix: Auto-Diagnose and Fix CI Failures

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding.

## Objective

Automatically pull CI failure logs, diagnose root cause, fix, commit, and re-push. Zero cognitive load.

---

## EXECUTION FLOW

### Step 1: Identify Failed Runs

```bash
# Get failed runs for current commit
gh run list --commit $(git rev-parse HEAD) --limit 5 --json status,conclusion,name,databaseId | jq '.[] | select(.conclusion == "failure")'
```

If no failures found, check the most recent run on the branch:
```bash
gh run list --branch $(git branch --show-current) --limit 3
```

### Step 2: Pull Failure Logs

For EACH failed run:
```bash
gh run view [RUN_ID] --log-failed 2>&1 | tail -100
```

Extract:
- **Failed step name**
- **Error message**
- **File and line number** (if available)
- **Exit code**

### Step 3: Diagnose

Map the failure to a known pattern:

| CI Step | Common Cause | Fix Strategy |
|---------|-------------|--------------|
| TypeScript | Type error in committed code | Fix the type error |
| ESLint | Lint violation | Fix or disable with justification |
| Build | Import error, missing dep | Fix import or install dep |
| Tests | Test failure | Fix test or code |

### Step 4: Fix

1. Apply the fix
2. Run the same check locally to verify:
   ```bash
   # Run the specific check that failed
   npm run build  # or whatever CI step failed
   ```
3. Verify fix passes locally

### Step 5: Commit and Re-Push

```bash
git add [fixed files]
git commit -m "fix(ci): [description of fix]

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
git push origin $(git branch --show-current)
```

### Step 6: Monitor Re-Run

```bash
# Wait for CI to complete (check periodically)
gh run list --branch $(git branch --show-current) --limit 1
```

If CI fails again, loop back to Step 2 (max 3 attempts).

---

## LOOP CONTROL

```
attempt = 0
MAX_ATTEMPTS = 3

WHILE attempt < MAX_ATTEMPTS:
  attempt += 1

  1. Pull failure logs
  2. Diagnose
  3. Fix
  4. Verify locally
  5. Commit + push
  6. Wait for CI

  IF CI passes:
    Output: "CI fixed in {attempt} attempt(s)"
    BREAK
  ELSE:
    Output: "Attempt {attempt} failed, retrying..."
    CONTINUE

IF attempt == MAX_ATTEMPTS AND still failing:
  Output: "CI still failing after 3 attempts. Manual investigation needed."
  Show: last failure logs
```

---

## OUTPUT FORMAT

```
== CI FIX ==

Failed Run: [workflow name] (#[run_id])
Failed Step: [step_name]
Error: [error message]

Diagnosis: [root cause]
Fix: [what was changed]

Local Verification: [check command] -> PASS
Committed: fix(ci): [description]
Pushed: origin/[branch]

CI Status: Monitoring...
  [step]: success

CI FIXED (1 attempt)
```

---

## START NOW

1. Identify failed CI runs
2. Pull logs for each failure
3. Diagnose, fix, verify locally
4. Commit and push
5. Monitor CI
6. Loop if needed (max 3)
