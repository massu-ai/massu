# Plan Item Extraction

> Reference doc for `/massu-loop`. Return to main file for overview.

## PLAN ITEM EXTRACTION PROTOCOL (MANDATORY - STEP 0)

**Before ANY implementation, extract ALL plan items into a trackable checklist.**

### Step 0.1: Read Plan Document (Not Memory)

```bash
cat [PLAN_FILE_PATH]
```

**You MUST read the plan file. Do NOT rely on memory or summaries.**

### Step 0.2: Extract ALL Deliverables

For EACH section of the plan, extract concrete items into a table:

```markdown
## PLAN ITEM EXTRACTION

### Source Document
- **Plan File**: [path]
- **Total Sections**: [N]

### Extracted Items
| Item # | Type | Description | Location | Verification Command | Status |
|--------|------|-------------|----------|---------------------|--------|
| P1-001 | FILE_CREATE | Component.tsx | src/components/ | ls -la [path] | PENDING |
| P1-002 | PROCEDURE | router.method | src/server/api/ | grep "method" [router] | PENDING |

### Item Types
FILE_CREATE, FILE_MODIFY, COMPONENT, PROCEDURE, MIGRATION, FEATURE, REMOVAL (VR-NEGATIVE), REFACTOR

### Coverage Summary
- **Total Items**: [N] | **Verified Complete**: 0 | **Coverage**: 0%
```

### Step 0.3: Create Verification Commands

| Item Type | Verification Method | Expected Result |
|-----------|---------------------|-----------------|
| FILE_CREATE | `ls -la [path]` | File exists, size > 0 |
| FILE_MODIFY | `grep "[change]" [file]` | Pattern found |
| COMPONENT | `grep "export.*ComponentName" [index]` | Export exists |
| PROCEDURE | `grep "[procedure]:" [router]` | Procedure defined |
| MIGRATION | `SELECT column_name FROM information_schema` | Column exists |
| FEATURE | Feature-specific grep | Functionality present |
| REMOVAL | `grep -rn "[old]" src/ \| wc -l` | 0 matches |

### Step 0.4: Track Coverage Throughout

After EVERY implementation action, update coverage count and verify with proof.

---

## PLAN DOCUMENT COMPLETION TRACKING (MANDATORY)

Add completion table to TOP of plan document with status for each task:

```markdown
# IMPLEMENTATION STATUS

**Plan**: [Name] | **Status**: COMPLETE/IN_PROGRESS | **Last Updated**: [date]

| # | Task/Phase | Status | Verification | Date |
|---|------------|--------|--------------|------|
| 1 | [description] | 100% COMPLETE | VR-GREP: 0 refs | 2026-01-20 |
```

### VR-PLAN-STATUS Verification

```bash
grep "IMPLEMENTATION STATUS" [plan_file]
grep -c "100% COMPLETE\|DONE\|\*\*DONE\*\*" [plan_file]
```
