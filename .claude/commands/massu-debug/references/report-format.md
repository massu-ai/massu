# Debug Report Format

Templates for the debug report and session state update.

---

## Debug Report Template

```markdown
## MASSU DEBUG REPORT

### Issue Summary
- **Reported**: [symptom]
- **Environment**: [DEV/PROD]
- **Severity**: P0/P1/P2

### Root Cause
[Technical explanation]

### CLAUDE.md Alignment
- Violation found: YES/NO
- Rule: [if yes]

### Fix
- Files changed: [list]
- Pattern applied: [from CLAUDE.md]

### Verification Evidence
| Check | Command | Result | Status |
|-------|---------|--------|--------|
| Build | npm run build | Exit 0 | PASS |
| Types | npx tsc --noEmit | 0 errors | PASS |
| Patterns | ./scripts/pattern-scanner.sh | Exit 0 | PASS |
| VR-NEGATIVE | grep [old] | 0 matches | PASS |

### Regression Check
- Related code reviewed: YES
- User flow tested: PASS

**DEBUG COMPLETE - Issue Resolved**
```

---

## Session State Update Template

After debugging, update `session-state/CURRENT.md`:

```markdown
## DEBUG SESSION

### Bug
- **Symptom**: [description]
- **Root Cause**: [technical cause]
- **CLAUDE.md Violation**: [if any]

### Investigation Path
1. [First thing checked]
2. [Second thing checked]
3. [Where root cause was found]

### Hypotheses Tested
| # | Hypothesis | Result |
|---|------------|--------|
| 1 | [theory] | REJECTED |
| 2 | [theory] | CONFIRMED |

### Fix Applied
- File: [path:line]
- Change: [description]

### Verification
- VR-NEGATIVE: [old pattern] -> 0 matches
- VR-BUILD: Exit 0
- VR-TYPE: 0 errors
- User flow: PASS

### Prevention
[How to prevent this in future]
```

---

## Plan Document Update (If Debug From Plan)

If debug session was part of a plan, update the plan document:

```markdown
# IMPLEMENTATION STATUS

**Plan**: [Plan Name]
**Status**: DEBUG COMPLETE / PARTIAL
**Last Updated**: [YYYY-MM-DD HH:MM]

## Bug Fixes Applied

| # | Bug Description | Status | Verification | Date |
|---|-----------------|--------|--------------|------|
| 1 | [Bug from plan] | FIXED | VR-BUILD: Pass | [date] |
| 2 | [Bug from plan] | FIXED | VR-TEST: Pass | [date] |

## Root Causes Identified

| Bug | Root Cause | Prevention |
|-----|-----------|------------|
| [bug] | [cause] | [how to prevent] |
```
