---
name: massu-gap-analyzer
description: Analyze plan implementation for gaps and enhancement opportunities (post-massu-loop)
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Massu Gap & Enhancement Analyzer

## Objective

Perform a comprehensive post-implementation review of a plan executed through massu-loop to identify:
1. **Gaps**: Missing functionality, incomplete implementations, untested paths, or deviations from plan
2. **Enhancements**: Opportunities to improve quality, performance, security, or functionality beyond the original scope

This is a READ-ONLY analysis tool. It does NOT make changes - it produces a detailed report for user review.

---

## WHEN TO USE THIS COMMAND

Use this command AFTER a plan has been implemented through `/massu-loop` to:
- Validate that ALL plan items were actually implemented
- Identify gaps that may have been missed during implementation
- Discover enhancement opportunities that became apparent during implementation
- Create a prioritized action list for follow-up work

---

## INPUT REQUIREMENTS

The user MUST provide:
1. **Plan file path**: The original plan document that was implemented
2. **Implementation scope**: Files/directories that were touched during implementation

If not provided, ask for these inputs before proceeding.

---

## PHASE 1: PLAN EXTRACTION & INVENTORY

### Step 1.1: Read the Complete Plan

```bash
# Read the entire plan document
cat [PLAN_FILE_PATH]
```

**Extract ALL of the following into structured inventory:**

| Category | What to Extract |
|----------|-----------------|
| **Source Code** | Modules, functions, classes, exports |
| **MCP Tools** | Tool definitions, handlers, registrations |
| **Config** | Config entries, schema changes |
| **Tests** | Test files, test coverage requirements |
| **Hooks** | Hook files, compilation requirements |
| **Documentation** | README updates, JSDoc additions |
| **Scripts** | Build scripts, scanner updates |

### Step 1.2: Create Plan Item Checklist

```markdown
## PLAN ITEM INVENTORY

| ID | Category | Item Description | Expected Location | Status |
|----|----------|------------------|-------------------|--------|
| P-001 | Tool | [tool_name] tool | packages/core/src/[file].ts | PENDING |
| P-002 | Test | [test_name] test | packages/core/src/__tests__/[file].test.ts | PENDING |
| P-003 | Config | [config_entry] | massu.config.yaml | PENDING |
| P-004 | Hook | [hook_name] | packages/core/src/hooks/[file].ts | PENDING |
```

---

## PHASE 2: IMPLEMENTATION VERIFICATION

### Step 2.1: Source Code Verification

For EACH source code item in the plan:

```bash
# Verify file exists
ls -la packages/core/src/[file].ts

# Verify exports
grep "export" packages/core/src/[file].ts

# Verify function/class exists
grep -n "[function_name]\|[class_name]" packages/core/src/[file].ts
```

### Step 2.2: Tool Registration Verification (CR-11)

For EACH MCP tool in the plan:

```bash
# Verify tool definitions exist
grep -n "[tool_name]" packages/core/src/[module].ts

# Verify registered in tools.ts
grep "[module]" packages/core/src/tools.ts

# Verify handler is wired
grep "handle\|is.*Tool" packages/core/src/tools.ts | grep "[module]"
```

### Step 2.3: Test Verification

For EACH test in the plan:

```bash
# Verify test file exists
ls -la packages/core/src/__tests__/[test].test.ts

# Verify tests pass
npm test -- --filter [test_name]
```

### Step 2.4: Config Verification

```bash
# Verify config entries exist
grep "[config_key]" massu.config.yaml
```

### Step 2.5: Hook Verification

```bash
# Verify hook compiles
cd packages/core && npm run build:hooks
```

### Step 2.6: Cross-Reference Verification

**MANDATORY**: Verify ALL new modules are properly integrated.

| Source Item | Integration Requirement | Verification |
|------------|------------------------|--------------|
| New tool module | Registered in tools.ts (CR-11) | grep in tools.ts |
| New config entries | Used by code | grep config key in src/ |
| New exports | Imported somewhere | grep import in src/ |
| New types | Used in handlers | grep type name in src/ |

---

## PHASE 3: GAP ANALYSIS

### Gap Categories

| Category | Definition | Severity |
|----------|------------|----------|
| **CRITICAL** | Feature doesn't work, crashes, or is missing | P0 |
| **REGISTRATION** | Module exists but not wired in (CR-11) | P0 |
| **MAJOR** | Significant functionality missing | P1 |
| **MINOR** | Small missing piece, cosmetic issue | P2 |
| **DEVIATION** | Implemented differently than planned (may be intentional) | P3 |

### Gap Detection Methods

#### 3.1: Plan-to-Implementation Gaps

Compare plan items against actual implementation:

```markdown
### PLAN-TO-IMPLEMENTATION GAPS

| Plan Item | Expected | Actual | Gap Type | Severity |
|-----------|----------|--------|----------|----------|
| P-001 | Tool X defined | Not found | MISSING_TOOL | CRITICAL |
| P-002 | Test Y passing | File exists but test fails | TEST_FAILURE | MAJOR |
```

#### 3.2: Cross-Reference Gaps

Check for inconsistencies between layers:

```bash
# Tool modules without registration in tools.ts
grep -rln "getToolDefinitions\|ToolDefinition" packages/core/src/ --include="*.ts" | grep -v __tests__ | \
  while read f; do
    name=$(basename "$f" .ts)
    grep -q "$name" packages/core/src/tools.ts || echo "UNREGISTERED: $name"
  done

# Exports without imports
grep -rn "export function\|export const" packages/core/src/[feature]*.ts | head -20
```

#### 3.3: Error Handling Gaps

```bash
# Check for try/catch in async operations
grep -rn "async.*=>" packages/core/src/[feature]*.ts | grep -v "try" | grep -v __tests__ | head -20

# Check for error responses in handlers
grep -rn "catch\|Error" packages/core/src/[feature]*.ts | grep -v __tests__ | head -10
```

#### 3.4: Test Coverage Gaps

```bash
# Find source files without corresponding tests
find packages/core/src/ -name "*.ts" ! -name "*.test.ts" ! -name "*.d.ts" ! -path "*__tests__*" ! -path "*hooks*" | while read f; do
  base=$(basename "$f" .ts)
  test_file="packages/core/src/__tests__/${base}.test.ts"
  [ ! -f "$test_file" ] && echo "NO TEST: $f"
done
```

---

## PHASE 4: ENHANCEMENT ANALYSIS

### Enhancement Categories

| Category | Description | Priority Framework |
|----------|-------------|-------------------|
| **Performance** | Speed, efficiency optimizations | Measurable benefit |
| **Security** | Hardening, additional checks | Risk reduction |
| **Functionality** | Feature extensions | User value |
| **Developer Experience** | Code quality, maintainability | Long-term value |
| **Testing** | Additional test coverage | Reliability |

### Enhancement Detection Methods

#### 4.1: Code Quality Enhancements

```bash
# Error handling completeness
grep -rn "catch.*{}" packages/core/src/ --include="*.ts" | grep -v __tests__

# Unused imports
grep -rn "^import" packages/core/src/ --include="*.ts" | grep -v __tests__ | head -20

# TODO/FIXME items
grep -rn "TODO\|FIXME\|HACK\|XXX" packages/core/src/ --include="*.ts" | grep -v __tests__
```

#### 4.2: Performance Enhancements

```bash
# Database queries without limits
grep -rn "SELECT \*\|findMany\|\.all(" packages/core/src/ --include="*.ts" | grep -v __tests__ | head -10

# Repeated operations that could be cached
grep -rn "getConfig()" packages/core/src/ --include="*.ts" | grep -v __tests__ | wc -l
```

#### 4.3: Security Enhancements

```bash
# Input validation gaps
grep -rn "args\.\|args\[" packages/core/src/ --include="*.ts" | grep -v "validate\|schema\|check" | grep -v __tests__ | head -10

# Unvalidated external input
grep -rn "JSON\.parse" packages/core/src/ --include="*.ts" | grep -v __tests__ | head -10
```

#### 4.4: Test Enhancements

Review existing tests for:
- Edge case coverage
- Error path testing
- Integration test gaps
- Performance test needs

---

## PHASE 5: REPORT GENERATION

### Report Structure

```markdown
# Gap & Enhancement Analysis Report

## Executive Summary

| Metric | Count |
|--------|-------|
| Plan Items | [N] |
| Verified Complete | [X] |
| Gaps Found | [G] |
| Critical Gaps | [C] |
| Enhancements Identified | [E] |

**Overall Score**: [X/N] items verified ([%]%)
**Gap Severity Distribution**: [C] Critical, [M] Major, [m] Minor

---

## Section 1: Plan Coverage Analysis

### Coverage Matrix

| Category | Items | Complete | Gaps | Coverage |
|----------|-------|----------|------|----------|
| Source Code | [N] | [X] | [G] | [%]% |
| Tools | [N] | [X] | [G] | [%]% |
| Tests | [N] | [X] | [G] | [%]% |
| Config | [N] | [X] | [G] | [%]% |
| **TOTAL** | [N] | [X] | [G] | [%]% |

---

## Section 2: Gap Report

### Critical Gaps (P0) - Must Fix

| ID | Gap Description | Expected | Actual | Impact | Remediation |
|----|-----------------|----------|--------|--------|-------------|
| G-001 | [description] | [expected] | [actual] | [impact] | [fix steps] |

### Major Gaps (P1) - Should Fix

| ID | Gap Description | Expected | Actual | Impact | Remediation |
|----|-----------------|----------|--------|--------|-------------|

### Minor Gaps (P2) - Nice to Fix

| ID | Gap Description | Expected | Actual | Impact | Remediation |
|----|-----------------|----------|--------|--------|-------------|

### Deviations (P3) - Review Needed

| ID | Deviation | Plan Specified | Implemented As | Reason (if known) |
|----|-----------|----------------|----------------|-------------------|

---

## Section 3: Enhancement Recommendations

### High-Impact Enhancements (Recommended)

| ID | Enhancement | Category | Impact | Effort | Priority |
|----|-------------|----------|--------|--------|----------|
| E-001 | [description] | Perf/Sec/DX | High/Med/Low | High/Med/Low | [1-5] |

---

## Section 4: Technical Debt Identified

| ID | Debt Type | Location | Description | Risk if Unaddressed |
|----|-----------|----------|-------------|---------------------|

---

## Section 5: Action Items

### Immediate Actions (Gaps)

- [ ] G-001: [fix description]

### Recommended Enhancements

- [ ] E-001: [enhancement description]

### Technical Debt Items

- [ ] TD-001: [debt resolution]
```

---

## PHASE 6: REPORT SAVING (MANDATORY)

**The report MUST be saved to the file system for future reference.**

### Report Storage Location

```
docs/reports/gap-analysis/
```

### Report Naming Convention

```
[YYYY-MM-DD]-[plan-name-slug]-gap-analysis.md
```

### Step 6.1: Create Reports Directory (if needed)

```bash
mkdir -p docs/reports/gap-analysis
```

### Step 6.2: Save the Complete Report

Write the full report (from Phase 5) to the report file.

### Step 6.3: Verification

```bash
# Verify report was saved
ls -la docs/reports/gap-analysis/[REPORT_FILE]

# Verify report has content
wc -l docs/reports/gap-analysis/[REPORT_FILE]
```

### Report Header (Include in Saved File)

```markdown
---
title: Gap & Enhancement Analysis Report
plan: [PLAN_FILE_PATH]
plan_name: [Plan Title]
analyzed_date: [YYYY-MM-DD HH:MM]
analyzer: Claude Code (massu-gap-analyzer)
---
```

### Report Footer (Include in Saved File)

```markdown
---

## Report Metadata

- **Generated**: [YYYY-MM-DD HH:MM]
- **Plan File**: [PLAN_FILE_PATH]
- **Analyzer**: massu-gap-analyzer v1.0

---

*This report was generated by Claude Code using the massu-gap-analyzer command.*
```

---

## EXECUTION FLOW

```
START
  |
  v
[PHASE 1: Plan Extraction]
  - Read complete plan file
  - Extract all items into inventory
  - Create checklist
  |
  v
[PHASE 2: Implementation Verification]
  - Source code verification
  - Tool registration verification (CR-11)
  - Test verification
  - Config verification
  - Hook verification
  - Cross-reference verification
  |
  v
[PHASE 3: Gap Analysis]
  - Plan-to-implementation gaps
  - Cross-reference gaps
  - Error handling gaps
  - Test coverage gaps
  |
  v
[PHASE 4: Enhancement Analysis]
  - Code quality enhancements
  - Performance enhancements
  - Security enhancements
  - Test enhancements
  |
  v
[PHASE 5: Report Generation]
  - Executive summary
  - Detailed gap report
  - Enhancement recommendations
  - Action items
  |
  v
[PHASE 6: Report Saving]
  - Create reports directory
  - Save report to docs/reports/gap-analysis/
  - Verify file saved
  |
  v
OUTPUT: Full analysis report (displayed AND saved)
```

---

## OUTPUT REQUIREMENTS

The final output MUST include:

1. **Executive Summary** with key metrics
2. **Coverage Matrix** showing plan completion percentage
3. **Gap Report** with severity, impact, and remediation for each gap
4. **Enhancement Recommendations** prioritized by impact/effort
5. **Action Items** checklist for follow-up work
6. **Verification Evidence** proving each check was performed

---

## IMPORTANT NOTES

- This command is READ-ONLY - it does NOT make changes
- All findings are recommendations - user decides what to act on
- Enhancements are optional - focus on gaps first
- Cross-reference findings with CLAUDE.md patterns
- Document evidence for every finding

---

## START NOW

1. Confirm plan file path with user
2. Read the complete plan document
3. Execute Phase 1-5 in order
4. Generate comprehensive report
5. Save report to `docs/reports/gap-analysis/[DATE]-[plan-name]-gap-analysis.md`
6. Present findings to user with report location
