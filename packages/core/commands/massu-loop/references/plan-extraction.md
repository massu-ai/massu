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
- **Plan Title**: [title]
- **Total Sections**: [N]

### Extracted Items
| Item # | Type | Description | Location | Verification Command | Status |
|--------|------|-------------|----------|---------------------|--------|
| P1-001 | MODULE_CREATE | foo-tools.ts | packages/core/src/ | ls -la [path] | PENDING |
| P1-002 | TOOL_WIRE | Wire into tools.ts | packages/core/src/tools.ts | grep [module] tools.ts | PENDING |
| P2-001 | TEST | foo.test.ts | packages/core/src/__tests__/ | npm test | PENDING |

### Item Types
- MODULE_CREATE: New TypeScript module
- MODULE_MODIFY: Existing module to change
- TOOL_WIRE: Wire tool into tools.ts
- TEST: Test file
- CONFIG: Config changes (config.ts + YAML)
- HOOK: New or modified hook
- REMOVAL: Code/file to remove (use VR-NEGATIVE)

### Coverage Summary
- **Total Items**: [N] | **Verified Complete**: 0 | **Coverage**: 0%
```

### Step 0.3: Create Verification Commands

| Item Type | Verification Method | Expected Result |
|-----------|---------------------|-----------------|
| MODULE_CREATE | `ls -la [path]` | File exists, size > 0 |
| MODULE_MODIFY | `grep "[change]" [file]` | Pattern found |
| TOOL_WIRE | `grep "getXDefs\|isXTool\|handleXCall" tools.ts` | All 3 present |
| TEST | `npm test` | All pass |
| CONFIG | Parse YAML, grep interface | Valid |
| HOOK | `cd packages/core && npm run build:hooks` | Exit 0 |
| REMOVAL | `grep -rn "[old]" packages/core/src/ | wc -l` | 0 matches |

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
| 1 | [description] | 100% COMPLETE | VR-GREP: 0 refs | [date] |
```

### VR-PLAN-STATUS Verification

```bash
grep "IMPLEMENTATION STATUS" [plan_file]
grep -c "100% COMPLETE\|DONE\|\*\*DONE\*\*" [plan_file]
```
