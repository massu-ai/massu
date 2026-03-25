---
name: massu-gap-enhancement-analyzer
description: "When user says 'analyze gaps', 'find enhancements', 'gap analysis', or has completed a massu-loop implementation and needs to identify remaining gaps and enhancement opportunities"
allowed-tools: Bash(*), Read(*), Write(*), Grep(*), Glob(*)
---
name: massu-gap-enhancement-analyzer

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding.

# Massu Gap & Enhancement Analyzer

## Objective

Perform a comprehensive post-implementation review of a plan executed through massu-loop to identify:
1. **Gaps**: Missing functionality, incomplete implementations, untested paths, or deviations from plan
2. **Enhancements**: Opportunities to improve UX, performance, security, or functionality beyond the original scope

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
| **Database** | Tables, columns, migrations, RLS policies, grants |
| **API/Routers** | Procedures, inputs, outputs, mutations, queries |
| **Components** | UI components, their locations, dependencies |
| **Pages** | Routes, page files, layouts |
| **Features** | User-facing functionality, workflows, integrations |
| **Configuration** | Environment variables, feature flags, settings |
| **Tests** | Test files, test coverage requirements |
| **Documentation** | Help site updates, README changes |

### Step 1.2: Create Plan Item Checklist

```markdown
## PLAN ITEM INVENTORY

| ID | Category | Item Description | Expected Location | Status |
|----|----------|------------------|-------------------|--------|
| P-001 | DB | [table_name] table | migration file | PENDING |
| P-002 | API | [procedure_name] procedure | routers/[file].ts | PENDING |
| P-003 | UI | [ComponentName] component | components/[path]/ | PENDING |
| P-004 | Feature | [Feature description] | [location] | PENDING |
```

---

## PHASE 2: IMPLEMENTATION VERIFICATION

### Step 2.1: Database Verification

For EACH database item in the plan:

```sql
-- Verify table exists
SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = '[TABLE]';

-- Verify columns match plan
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = '[TABLE]'
ORDER BY ordinal_position;

-- Verify RLS policies
SELECT polname, polcmd FROM pg_policies WHERE tablename = '[TABLE]';

-- Verify grants
SELECT grantee, privilege_type FROM information_schema.table_privileges
WHERE table_name = '[TABLE]' AND grantee IN ('authenticated', 'service_role');
```

### Step 2.2: API/Router Verification

For EACH procedure in the plan:

```bash
# Verify procedure exists
grep -n "[procedure_name]:" src/server/api/routers/[router].ts

# Verify uses correct procedure type
grep -B 2 "[procedure_name]:" src/server/api/routers/[router].ts | grep "protectedProcedure\|publicProcedure"

# Verify input schema
grep -A 20 "[procedure_name]:" src/server/api/routers/[router].ts | grep -A 10 "input:"

# Verify router is exported in root
grep "[router]" src/server/api/root.ts
```

### Step 2.3: Component Verification

For EACH UI component in the plan:

```bash
# Verify component file exists
ls -la src/components/[path]/[ComponentName].tsx

# CRITICAL: Verify component is RENDERED in a page
grep -rn "<[ComponentName]" src/app/

# Verify component imports are correct
grep -n "import.*[ComponentName]" src/app/**/page.tsx
```

### Step 2.4: Backend-Frontend Coupling Verification (CRITICAL)

**MANDATORY**: Verify ALL backend features are exposed in frontend.

```bash
# Run automated coupling check
./scripts/check-coupling.sh
```

**Manual verification for plan-specific items:**

| Backend Item | Frontend Requirement | Verification |
|--------------|---------------------|--------------|
| z.enum values in router | SELECT options in form | grep values in constants.ts |
| New API procedure | UI component calls it | grep api.[router].[proc] in components |
| Input schema fields | Form has all fields | grep field names in form component |
| Type definitions | Frontend types match | compare router types to component types |

```markdown
### Backend-Frontend Coupling Status
| Backend Feature | Frontend Exposure | Status |
|-----------------|-------------------|--------|
| [feature] | [component/form] | PRESENT/MISSING |
```

---

## PHASE 3: GAP ANALYSIS

### Gap Categories

| Category | Definition | Severity |
|----------|------------|----------|
| **CRITICAL** | Feature doesn't work, data loss risk, security issue | P0 |
| **COUPLING** | Backend feature not exposed in UI (users can't access it) | P0 |
| **MAJOR** | Significant functionality missing, UX broken | P1 |
| **MINOR** | Small missing piece, cosmetic issue | P2 |
| **DEVIATION** | Implemented differently than planned (may be intentional) | P3 |

### Gap Detection Methods

#### 3.1: Plan-to-Implementation Gaps

Compare plan items against actual implementation:

```markdown
### PLAN-TO-IMPLEMENTATION GAPS

| Plan Item | Expected | Actual | Gap Type | Severity |
|-----------|----------|--------|----------|----------|
| P-001 | Table X with columns A,B,C | Only A,B exist | MISSING_COLUMN | MAJOR |
| P-002 | Procedure Y | Not found | MISSING_PROCEDURE | CRITICAL |
| P-003 | Component Z | File exists but not rendered | NOT_RENDERED | CRITICAL |
```

#### 3.2: Cross-Reference Gaps

Check for inconsistencies between layers:

```bash
# API procedures without UI consumers
grep -rn "api\.[router]\.[procedure]" src/components/ src/app/ | wc -l
# If 0, procedure may be unused

# Components without page integration
find src/components/[feature]/ -name "*.tsx" | while read f; do
  name=$(basename "$f" .tsx)
  grep -rn "<$name" src/app/ || echo "ORPHAN: $name"
done
```

#### 3.3: Error Handling Gaps

```bash
# Check for try/catch in async operations
grep -rn "async.*=>" src/server/api/routers/[feature]*.ts | grep -v "try" | head -20

# Check for loading states
grep -rn "useState.*loading\|isLoading\|isPending" src/components/[feature]/ | wc -l
```

---

## PHASE 4: ENHANCEMENT ANALYSIS

### Enhancement Categories

| Category | Description | Priority Framework |
|----------|-------------|-------------------|
| **UX** | User experience improvements | Impact vs Effort |
| **Performance** | Speed, efficiency optimizations | Measurable benefit |
| **Security** | Hardening, additional checks | Risk reduction |
| **Functionality** | Feature extensions | User value |
| **Developer Experience** | Code quality, maintainability | Long-term value |
| **Accessibility** | A11y improvements | Compliance + UX |

### Enhancement Detection Methods

#### 4.1: UX Enhancements

```bash
# Empty states - are they helpful?
grep -rn "length === 0\|EmptyState" src/components/[feature]/

# Loading states - are they smooth?
grep -rn "isLoading\|Skeleton\|Spinner" src/components/[feature]/

# Success feedback - is it clear?
grep -rn "toast.success" src/components/[feature]/
```

#### 4.2: Performance Enhancements

```bash
# Large list rendering - virtualization needed?
grep -rn "map.*=>" src/components/[feature]/ | grep -v "slice\|virtualized"

# API calls - batching opportunity?
grep -rn "useQuery\|useMutation" src/components/[feature]/ | wc -l
```

#### 4.3: Security Enhancements

```bash
# Input sanitization
grep -rn "z\.string()" src/server/api/routers/[feature]*.ts | grep -v "min\|max\|regex"
```

#### 4.4: Accessibility Enhancements

```bash
# ARIA attributes
grep -rn "aria-\|role=" src/components/[feature]/

# Alt text
grep -rn "<img\|<Image" src/components/[feature]/ | grep -v "alt="
```

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

| Phase | Items | Complete | Gaps | Coverage |
|-------|-------|----------|------|----------|
| Phase 1 | [N] | [X] | [G] | [%]% |
| Phase 2 | [N] | [X] | [G] | [%]% |
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

---

## Section 3: Enhancement Recommendations

### High-Impact Enhancements (Recommended)

| ID | Enhancement | Category | Impact | Effort | Priority |
|----|-------------|----------|--------|--------|----------|
| E-001 | [description] | UX/Perf/Sec | High/Med/Low | High/Med/Low | [1-5] |

---

## Section 4: Technical Debt Identified

| ID | Debt Type | Location | Description | Risk if Unaddressed |
|----|-----------|----------|-------------|---------------------|
| TD-001 | [type] | [file:line] | [description] | [risk] |

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
  - Database verification
  - API/Router verification
  - Component verification
  - Feature verification
  - Configuration verification
  |
  v
[PHASE 3: Gap Analysis]
  - Plan-to-implementation gaps
  - Cross-reference gaps
  - Error handling gaps
  |
  v
[PHASE 4: Enhancement Analysis]
  - UX enhancements
  - Performance enhancements
  - Security enhancements
  - Accessibility enhancements
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
  - Save report to .claude/reports/gap-analysis/
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

## PHASE 6: REPORT SAVING (MANDATORY)

### Report Storage Location

```
.claude/reports/gap-analysis/
```

### Report Naming Convention

```
[YYYY-MM-DD]-[plan-name-slug]-gap-analysis.md
```

### Step 6.1: Create Reports Directory (if needed)

```bash
mkdir -p .claude/reports/gap-analysis
```

### Step 6.2: Save the Complete Report

Write the full report (from Phase 5) to the report file.

### Step 6.3: Verification

```bash
# Verify report was saved
ls -la .claude/reports/gap-analysis/[REPORT_FILE]

# Verify report has content
wc -l .claude/reports/gap-analysis/[REPORT_FILE]
```

---

## IMPORTANT NOTES

- This command is READ-ONLY - it does NOT make changes
- All findings are recommendations - user decides what to act on
- Enhancements are optional - focus on gaps first
- Document evidence for every finding

---

## START NOW

1. Confirm plan file path with user
2. Read the complete plan document
3. Execute Phase 1-5 in order
4. Generate comprehensive report
5. Save report to `.claude/reports/gap-analysis/`
6. Present findings to user with report location
