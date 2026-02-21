---
name: massu-retrospective
description: Session or sprint retrospective — what worked, what didn't, patterns learned, and follow-up actions
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---
name: massu-retrospective

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# CS Retrospective: Session & Sprint Retrospective

## Objective

Conduct a structured retrospective by analyzing git history, session state, test results, and pattern violations. Surfaces what worked, what didn't, recurring patterns, and concrete follow-up actions. This is READ-ONLY — no files are modified.

**Usage**: `/massu-retrospective` (since last retro) or `/massu-retrospective [N]` (last N commits) or `/massu-retrospective [date]` (since date, e.g., 2026-02-01)

---

## NON-NEGOTIABLE RULES

- Do NOT modify any files
- Do NOT fix any issues found (report only)
- Base ALL findings on actual data — git log, test output, session state
- FIX ALL ISSUES ENCOUNTERED (CR-9) — if issues are found, they MUST be flagged for follow-up
- Do NOT skip sections because data is unavailable — explain what data is missing and why

---

## STEP 1: DATA GATHERING

Collect all data before drawing any conclusions.

### 1a. Commit History

```bash
# Determine scope
if [ -n "$ARGUMENTS" ] && echo "$ARGUMENTS" | grep -qE '^[0-9]+$'; then
  git log -${ARGUMENTS} --oneline --stat 2>&1
elif [ -n "$ARGUMENTS" ] && echo "$ARGUMENTS" | grep -qE '^[0-9]{4}-'; then
  git log --since="$ARGUMENTS" --oneline --stat 2>&1
else
  # Since last retro tag or last 20 commits
  git log -20 --oneline --stat 2>&1
fi
```

### 1b. Commit Breakdown by Type

```bash
git log -20 --format="%s" 2>/dev/null | \
  grep -oE "^(feat|fix|chore|refactor|test|docs|perf|ci|build|style)" | \
  sort | uniq -c | sort -rn
```

### 1c. Files Most Frequently Changed

```bash
git log -20 --name-only --pretty="" 2>/dev/null | sort | uniq -c | sort -rn | head -20
```

### 1d. Session State

```bash
cat .claude/session-state/CURRENT.md 2>/dev/null || echo "No session state file found"
```

### 1e. Current Test Health

```bash
npm test 2>&1 | tail -20
```

### 1f. Pattern Compliance

```bash
bash scripts/massu-pattern-scanner.sh 2>&1
```

### 1g. Type Safety

```bash
cd packages/core && npx tsc --noEmit 2>&1 | tail -10
```

### 1h. Open Issues in Code

```bash
grep -rn "TODO\|FIXME\|HACK\|XXX" packages/core/src/ --include="*.ts" | grep -v "__tests__"
```

### 1i. Plan Files Modified

```bash
ls -lt docs/plans/*.md 2>/dev/null | head -10
```

---

## STEP 2: TREND ANALYSIS

Analyze the data collected in Step 1 for patterns.

### 2a. Velocity Metrics

```markdown
### Velocity Metrics

| Metric | Value |
|--------|-------|
| Total commits | [N] |
| Features | [N] |
| Bug fixes | [N] |
| Refactors | [N] |
| Tests | [N] |
| Docs | [N] |
| Chores | [N] |
```

### 2b. Change Hotspots

Identify files changed >= 3 times in the period — these are either high-activity areas or signs of instability:

```markdown
### Change Hotspots

| File | Changes | Interpretation |
|------|---------|----------------|
| [file] | [N] | [HIGH ACTIVITY / INSTABILITY / ITERATION] |
```

### 2c. Test Health Trend

```bash
# Compare current test count against any previous baseline in session state
grep -n "tests\|passing\|failing" .claude/session-state/CURRENT.md 2>/dev/null | head -10
```

---

## STEP 3: PATTERN IDENTIFICATION

Identify recurring patterns — both positive and negative.

### 3a. What Worked Well

Look for evidence in git log and session state:

```markdown
### What Worked Well

| Pattern | Evidence | Impact |
|---------|----------|--------|
| [e.g., incremental commits] | [commit count, description] | [fewer rollbacks, clean history] |
| [e.g., test-first approach] | [test commits before feat commits] | [0 regressions] |
```

### 3b. What Didn't Work

Look for evidence of retries, reverts, or TODOs:

```bash
# Reverts in history
git log -20 --oneline 2>/dev/null | grep -i "revert\|undo\|rollback"

# Failed attempts (WIP commits)
git log -20 --oneline 2>/dev/null | grep -i "wip\|temp\|fixup\|squash"
```

```markdown
### What Didn't Work

| Pattern | Evidence | Root Cause |
|---------|----------|-----------|
| [e.g., large batch changes] | [revert commits] | [too many files changed at once] |
| [e.g., missing tests] | [bug fix commits following feat] | [feature shipped without tests] |
```

### 3c. CR Compliance Review

Check adherence to Canonical Rules during the period:

```markdown
### CR Compliance

| Rule | Violations | Evidence | Status |
|------|-----------|----------|--------|
| CR-1 (Never claim without proof) | [N] | [examples from session state] | PASS/WARN/FAIL |
| CR-4 (Verify removals) | [N] | [negative grep results] | PASS/WARN/FAIL |
| CR-7 (Tests pass before complete) | [N] | [test failures after "complete"] | PASS/WARN/FAIL |
| CR-9 (Fix all issues) | [N] | [open TODOs in code] | PASS/WARN/FAIL |
| CR-11 (Tool registration) | [N] | [unregistered tools, if any] | PASS/WARN/FAIL |
```

---

## STEP 4: REPORT GENERATION

Generate the structured retrospective report. Output directly — do NOT write to a file unless asked.

---

## OUTPUT FORMAT

```markdown
# Massu Retrospective

**Period**: [date range from git log]
**Commits Reviewed**: [N]
**Generated**: [today's date]

---

## Health Snapshot (End of Period)

| Metric | Value | Status |
|--------|-------|--------|
| Tests passing | [N]/[N] | PASS/FAIL |
| Type errors | [N] | PASS/FAIL |
| Pattern violations | [N] | PASS/FAIL |
| Open TODOs | [N] | INFO |

---

## Velocity

| Type | Count | % of Total |
|------|-------|-----------|
| Features | [N] | [N]% |
| Bug fixes | [N] | [N]% |
| Refactors | [N] | [N]% |
| Tests | [N] | [N]% |
| Chores/Docs | [N] | [N]% |

**Top Changed Files**:
| File | Changes | Note |
|------|---------|------|
| [file] | [N] | [high activity / iteration] |

---

## What Went Well

1. **[Pattern name]** — [evidence and impact]
2. **[Pattern name]** — [evidence and impact]
3. **[Pattern name]** — [evidence and impact]

---

## What Needs Improvement

1. **[Pattern name]** — [evidence, root cause, and impact]
2. **[Pattern name]** — [evidence, root cause, and impact]

---

## CR Compliance Summary

| Rule | Result | Notes |
|------|--------|-------|
| CR-1 Never claim without proof | PASS/FAIL | [details] |
| CR-4 Verify removals | PASS/FAIL | [details] |
| CR-7 Tests before complete | PASS/FAIL | [details] |
| CR-9 Fix all issues | PASS/FAIL | [open items count] |

---

## Key Learnings

1. [Specific, actionable learning derived from data]
2. [Specific, actionable learning derived from data]
3. [Specific, actionable learning derived from data]

---

## Follow-Up Actions (Priority Order)

| # | Action | Priority | Suggested Command |
|---|--------|----------|------------------|
| 1 | [specific action] | HIGH | `/massu-hotfix` or `/massu-create-plan` |
| 2 | [specific action] | MED | [command] |
| 3 | [specific action] | LOW | [command] |

---

## Unresolved TODOs

| File:Line | Comment | Age (commits) | Suggested Action |
|-----------|---------|--------------|-----------------|
| [loc] | [text] | [N] | [action] |
```

---

## COMPLETION REPORT

```markdown
## CS RETROSPECTIVE COMPLETE

### Data Sources Used
| Source | Status | Records |
|--------|--------|---------|
| Git log | READ | [N] commits |
| Session state | READ/NOT FOUND | [N] entries |
| Test suite | RUN | [N] tests |
| Pattern scanner | RUN | [N] violations |
| Code TODOs | SCANNED | [N] found |

### Period Summary
- **Commits analyzed**: [N]
- **Files changed**: [N unique files]
- **Health at end of period**: HEALTHY/DEGRADED/UNHEALTHY

### Top 3 Follow-up Actions
1. [Most critical]
2. [Second most critical]
3. [Third most critical]
```
