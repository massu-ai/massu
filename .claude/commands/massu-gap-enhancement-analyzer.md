---
name: massu-gap-enhancement-analyzer
description: "When user says 'analyze gaps', 'find enhancements', 'gap analysis', or has completed a massu-loop implementation and needs to identify remaining gaps and enhancement opportunities"
allowed-tools: Bash(*), Read(*), Write(*), Grep(*), Glob(*), ToolSearch(mcp__supabase__*)
---
name: massu-gap-enhancement-analyzer

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-14, CR-5, CR-12 enforced.

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

**Check ALL 3 environments:**
- DEV (gwqkbjymbarkufwvdmar)
- OLD PROD (hwaxogapihsqleyzpqtj)
- NEW PROD (cnfxxvrhhvjefyvpoqlq)

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

# Verify component is exported
grep "export.*[ComponentName]" src/components/[path]/index.ts

# CRITICAL: Verify component is RENDERED in a page
grep -rn "<[ComponentName]" src/app/

# Verify component imports are correct
grep -n "import.*[ComponentName]" src/app/**/page.tsx
```

### Step 2.4: Feature Verification

For EACH feature in the plan:

```bash
# Feature-specific verification based on plan requirements
# This varies by feature type - document what was checked
```

### Step 2.5: Configuration Verification

```bash
# Verify feature flags exist and are enabled
# Use MCP tools to query feature_flags table in all environments

# Verify environment variables are documented
grep -rn "process.env.[VAR_NAME]" src/
```

### Step 2.6: Backend-Frontend Coupling Verification (CRITICAL - Added Jan 2026)

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

**Why this matters**: Jan 2026 Incident - Backend had tier-based scraper types (browserless, persistent_browser, manual_assist, auto) but UI form only showed original 7 options. ALL other verifications passed. VR-COUPLING catches this class of gap.

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

### Gap Type: COUPLING (Added Jan 2026)

**Definition**: Backend has a feature (enum value, procedure, type) that frontend doesn't expose.

**Why P0 (Critical)**: Users cannot access the feature even though the code exists. This is a complete failure from the user's perspective.

**Examples**:
- Backend z.enum has value "auto" but UI SELECT doesn't show it
- Backend has procedure `analyze` but UI never calls it
- Backend input schema has field `maxRetries` but form doesn't include it

**How to detect**:
```bash
./scripts/check-coupling.sh
```

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

# Database columns not used in routers
# Compare schema columns against router select/where clauses
```

#### 3.3: User Flow Gaps

Trace complete user journeys:

```markdown
### USER FLOW ANALYSIS

| Flow | Entry Point | Steps | Completion | Gaps |
|------|-------------|-------|------------|------|
| [Flow name] | [route] | 1. Click X, 2. Enter Y | Complete/Broken | [gaps] |
```

#### 3.4: Error Handling Gaps

```bash
# Check for try/catch in async operations
grep -rn "async.*=>" src/server/api/routers/[feature]*.ts | grep -v "try" | head -20

# Check for toast.error on mutations
grep -rn "useMutation" src/components/[feature]/ | while read f; do
  grep -L "toast.error\|onError" "$f"
done

# Check for loading states
grep -rn "useState.*loading\|isLoading\|isPending" src/components/[feature]/ | wc -l
```

#### 3.5: Test Coverage Gaps

```bash
# Find files without corresponding tests
find src/server/api/routers/[feature]*.ts | while read f; do
  test="${f%.ts}.test.ts"
  [ ! -f "$test" ] && echo "NO TEST: $f"
done

find src/components/[feature]/ -name "*.tsx" | while read f; do
  test="${f%.tsx}.test.tsx"
  [ ! -f "$test" ] && echo "NO TEST: $f"
done
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

# Form validation - is it immediate?
grep -rn "FormField\|FormMessage\|error" src/components/[feature]/
```

**UX Enhancement Checklist:**
- [ ] Keyboard navigation supported?
- [ ] Focus management correct?
- [ ] Transitions smooth?
- [ ] Error messages helpful?
- [ ] Success states clear?
- [ ] Undo/recovery options?

#### 4.2: Performance Enhancements

```bash
# Large list rendering - virtualization needed?
grep -rn "map.*=>" src/components/[feature]/ | grep -v "slice\|virtualized"

# Unnecessary re-renders - memo needed?
grep -rn "useMemo\|useCallback\|React.memo" src/components/[feature]/ | wc -l

# Heavy computations - should be cached?
grep -rn "filter\|reduce\|sort" src/components/[feature]/ | grep -v "useMemo"

# API calls - batching opportunity?
grep -rn "useQuery\|useMutation" src/components/[feature]/ | wc -l
```

#### 4.3: Security Enhancements

```bash
# Input sanitization
grep -rn "z\.string()" src/server/api/routers/[feature]*.ts | grep -v "min\|max\|regex"

# Rate limiting considerations
grep -rn "rateLimit\|throttle" src/server/api/routers/[feature]*.ts

# Audit logging
grep -rn "log\.\|console\." src/server/api/routers/[feature]*.ts | grep -v "error"
```

#### 4.4: Functionality Enhancements

Review the feature for natural extensions:
- Bulk operations where only single exists
- Export/import capabilities
- Filtering/sorting options
- Search functionality
- Pagination improvements
- Notification/alert options
- Integration opportunities

#### 4.5: Accessibility Enhancements

```bash
# ARIA attributes
grep -rn "aria-\|role=" src/components/[feature]/

# Alt text
grep -rn "<img\|<Image" src/components/[feature]/ | grep -v "alt="

# Focus indicators
grep -rn "focus:\|:focus" src/components/[feature]/

# Color contrast (manual check needed)
grep -rn "text-\|bg-" src/components/[feature]/ | head -20
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
| ... | ... | ... | ... | ... |
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
| G-002 | [description] | [expected] | [actual] | [impact] | [fix steps] |

### Minor Gaps (P2) - Nice to Fix

| ID | Gap Description | Expected | Actual | Impact | Remediation |
|----|-----------------|----------|--------|--------|-------------|
| G-003 | [description] | [expected] | [actual] | [impact] | [fix steps] |

### Deviations (P3) - Review Needed

| ID | Deviation | Plan Specified | Implemented As | Reason (if known) |
|----|-----------|----------------|----------------|-------------------|
| D-001 | [description] | [plan] | [actual] | [reason] |

---

## Section 3: Enhancement Recommendations

### High-Impact Enhancements (Recommended)

| ID | Enhancement | Category | Impact | Effort | Priority |
|----|-------------|----------|--------|--------|----------|
| E-001 | [description] | UX/Perf/Sec | High/Med/Low | High/Med/Low | [1-5] |

**Detailed Recommendations:**

#### E-001: [Enhancement Title]

**Current State**: [what exists now]

**Proposed Enhancement**: [what should be added/changed]

**Benefits**:
- [benefit 1]
- [benefit 2]

**Implementation Notes**:
- [note 1]
- [note 2]

**Estimated Scope**: [small/medium/large]

---

### Medium-Impact Enhancements (Consider)

| ID | Enhancement | Category | Impact | Effort | Priority |
|----|-------------|----------|--------|--------|----------|
| E-002 | [description] | [category] | Medium | [effort] | [priority] |

---

### Low-Impact Enhancements (Backlog)

| ID | Enhancement | Category | Notes |
|----|-------------|----------|-------|
| E-003 | [description] | [category] | [notes] |

---

## Section 4: Technical Debt Identified

| ID | Debt Type | Location | Description | Risk if Unaddressed |
|----|-----------|----------|-------------|---------------------|
| TD-001 | [type] | [file:line] | [description] | [risk] |

---

## Section 5: Action Items

### Immediate Actions (Gaps)

- [ ] G-001: [fix description]
- [ ] G-002: [fix description]

### Recommended Enhancements

- [ ] E-001: [enhancement description]
- [ ] E-002: [enhancement description]

### Technical Debt Items

- [ ] TD-001: [debt resolution]

---

## Appendix: Verification Evidence

### Database Verification

| Table | DEV | OLD PROD | NEW PROD | Status |
|-------|-----|----------|----------|--------|
| [table] | [result] | [result] | [result] | PASS/FAIL |

### API Verification

| Procedure | File | Line | Protected | Status |
|-----------|------|------|-----------|--------|
| [proc] | [file] | [line] | YES/NO | PASS/FAIL |

### Component Verification

| Component | File Exists | Exported | Rendered | Status |
|-----------|-------------|----------|----------|--------|
| [comp] | YES/NO | YES/NO | YES/NO | PASS/FAIL |
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
  - Database verification (all 3 envs)
  - API/Router verification
  - Component verification
  - Feature verification
  - Configuration verification
  |
  v
[PHASE 3: Gap Analysis]
  - Plan-to-implementation gaps
  - Cross-reference gaps
  - User flow gaps
  - Error handling gaps
  - Test coverage gaps
  |
  v
[PHASE 4: Enhancement Analysis]
  - UX enhancements
  - Performance enhancements
  - Security enhancements
  - Functionality enhancements
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
  - Create reports directory
  - Save report to project docs reports/gap-analysis/
  - Update INDEX.md
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

**The report MUST be saved to the file system for future reference.**

### Report Storage Location

```
reports/gap-analysis/
```

### Report Naming Convention

```
[YYYY-MM-DD]-[plan-name-slug]-gap-analysis.md
```

**Example**: `2026-01-23-development-intelligence-lead-qualification-gap-analysis.md`

### Step 6.1: Create Reports Directory (if needed)

```bash
mkdir -p reports/gap-analysis
```

### Step 6.2: Generate Report Filename

Extract plan name from the plan file path and create slug:

```bash
# Example: /path/to/2026-01-22-development-intelligence-lead-qualification-system.md
# Becomes: development-intelligence-lead-qualification-system

PLAN_NAME=$(basename "[PLAN_FILE_PATH]" .md | sed 's/^[0-9-]*//')
DATE=$(date +%Y-%m-%d)
REPORT_FILE="reports/gap-analysis/${DATE}-${PLAN_NAME}-gap-analysis.md"
```

### Step 6.3: Save the Complete Report

Write the full report (from Phase 5) to the report file:

```bash
# Use the Write tool to save the complete report to:
# reports/gap-analysis/[DATE]-[plan-name]-gap-analysis.md
```

### Step 6.4: Create/Update Reports Index

Maintain an index file at `reports/gap-analysis/INDEX.md`:

```markdown
# Gap & Enhancement Analysis Reports

| Date | Plan | Gaps | Enhancements | Coverage | Report |
|------|------|------|--------------|----------|--------|
| 2026-01-23 | [Plan Name] | [G] | [E] | [%]% | [link to report] |
```

### Step 6.5: Verification

```bash
# Verify report was saved
ls -la reports/gap-analysis/[REPORT_FILE]

# Verify report has content
wc -l reports/gap-analysis/[REPORT_FILE]
```

### Report Header (Include in Saved File)

The saved report MUST include this metadata header:

```markdown
---
title: Gap & Enhancement Analysis Report
plan: [PLAN_FILE_PATH]
plan_name: [Plan Title]
analyzed_date: [YYYY-MM-DD HH:MM]
analyzer: Claude Code (massu-gap-enhancement-analyzer)
---
```

### Report Footer (Include in Saved File)

```markdown
---

## Report Metadata

- **Generated**: [YYYY-MM-DD HH:MM]
- **Plan File**: [PLAN_FILE_PATH]
- **Report Location**: reports/gap-analysis/[REPORT_FILE]
- **Analyzer**: massu-gap-enhancement-analyzer v1.0

---

*This report was generated by Claude Code using the massu-gap-enhancement-analyzer command.*
```

---

## IMPORTANT NOTES

- This command is READ-ONLY - it does NOT make changes
- All findings are recommendations - user decides what to act on
- Enhancements are optional - focus on gaps first
- Cross-reference findings with CLAUDE.md patterns
- Use VR-* verification protocols for all checks
- Document evidence for every finding

---

## START NOW

1. Confirm plan file path with user
2. Read the complete plan document
3. Execute Phase 1-5 in order
4. Generate comprehensive report
5. **Save report to `reports/gap-analysis/[DATE]-[plan-name]-gap-analysis.md`**
6. **Update INDEX.md with report entry**
7. Present findings to user with report location
