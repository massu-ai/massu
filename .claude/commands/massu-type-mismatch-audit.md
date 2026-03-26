---
name: massu-type-mismatch-audit
description: "When user says 'type audit', 'type mismatch', 'check types', or suspects type inconsistencies between frontend, backend, and database columns"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*), Task(*)
disable-model-invocation: true
---
name: massu-type-mismatch-audit

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-14, CR-5, CR-12 enforced.

# Massu Type Mismatch Audit: Comprehensive Type Safety Verification

## Objective

Audit the ENTIRE codebase for type mismatches between:
1. Frontend form schemas and backend router schemas
2. Backend code and database column types
3. `as any` casts hiding real type issues in API calls
4. Array vs string mismatches on array-type database columns
5. Number/date/boolean coercion gaps in form submissions
6. Return type mismatches (serialization, BigInt, Decimal)

**This audit catches bugs that TypeScript CANNOT catch** - runtime Zod validation failures, database insert failures from wrong column types, and `as any` casts that hide structural mismatches.

---

## NON-NEGOTIABLE RULES

- **Trace the full path** - Frontend form -> API call -> Zod schema -> DB column
- **Verify against DB schema** - ALWAYS query `information_schema` for column types
- **`as any` = suspect** - Every `as any` in an API call context is a potential hidden mismatch
- **Array columns are special** - `text[]` columns MUST receive arrays, not strings
- **Show proof** - Every finding must include file:line and the exact mismatch

---

## ZERO-GAP AUDIT LOOP

**Type mismatch audit does NOT complete until a SINGLE COMPLETE AUDIT finds ZERO new issues.**

```
TYPE MISMATCH AUDIT LOOP:
  1. Run ALL 8 audit sections
  2. Count total mismatches found
  3. IF mismatches > 0:
       - Document ALL mismatches in plan file
       - Fix ALL mismatches
       - Re-run ENTIRE audit from Section 1
  4. IF mismatches == 0:
       - TYPE SAFETY VERIFIED
```

---

## ARGUMENTS

This command accepts an optional scope argument:

- No argument: Full codebase audit (all 8 sections)
- `[router-name]`: Audit a specific router and its frontend consumers

---

## SECTION 1: DATABASE ARRAY COLUMN INVENTORY

**Goal**: Identify ALL array-type columns and verify code sends arrays (not strings) to them.

### 1.1 Query Array Columns from Prisma Schema
```bash
# Find all array fields in Prisma schema
grep -n "\[\]" prisma/schema.prisma | grep -v "//"
```

### 1.2 Query Array Columns from Database
```sql
-- Run on database
SELECT table_name, column_name, data_type, column_default
FROM information_schema.columns
WHERE data_type = 'ARRAY'
AND table_schema = 'public'
ORDER BY table_name, column_name;
```

### 1.3 For EACH Array Column, Verify All Writes

For every array column found, search for all places that SET that column:

```bash
# Pattern: find all assignments to this column in create/update operations
grep -rn "column_name:" src/server/api/routers/ | grep -v "where\|orderBy\|select"
```

**CHECK**: Is the value being assigned actually an array? Or a single string/number?

### 1.4 Array Column Verification Matrix

```markdown
| Table | Column | DB Type | Code Sends | Mismatch? | File:Line |
|-------|--------|---------|------------|-----------|-----------|
| tasks | department | text[] | ['admin'] | NO | tasks.ts:30 |
| tasks | department | text[] | 'admin' | YES - BUG | tasks.ts:922 |
```

---

## SECTION 2: FRONTEND-BACKEND ZOD SCHEMA COMPARISON

**Goal**: Compare Zod schemas in frontend forms against backend router input schemas for the SAME procedure.

### 2.1 Inventory All Frontend Form Schemas

```bash
# Find all Zod schemas in components and app pages
grep -rn "z\.object(" src/components/ src/app/ | grep -v node_modules | grep -v "server/"
```

### 2.2 Inventory All Backend Input Schemas

```bash
# Find all .input() schemas in routers
grep -rn "\.input(z\.\|\.input(" src/server/api/routers/
```

### 2.3 Match Frontend to Backend

For each frontend form that calls a mutation:
1. Find the mutation call: `api.[router].[procedure].useMutation`
2. Find the corresponding backend `.input()` schema
3. Compare field-by-field:
   - Same field names?
   - Same types? (string vs array, number vs string, enum values match?)
   - Same optionality? (required vs optional)

### 2.4 Schema Comparison Matrix

```markdown
| Frontend File | Backend Router | Procedure | Field | Frontend Type | Backend Type | Match? |
|---------------|---------------|-----------|-------|---------------|--------------|--------|
| NewTaskSheet.tsx | tasks.ts | create | department | z.enum() | z.array(z.enum()) | NO |
```

---

## SECTION 3: `as any` CAST AUDIT

**Goal**: Find ALL `as any` casts in API call contexts and determine if they hide real type mismatches.

### 3.1 Find All `as any` in API Calls

```bash
# as any near mutateAsync/mutate calls
grep -rn "as any" src/components/ src/app/ | grep -v node_modules | grep -v "\.d\.ts"
```

### 3.2 Categorize Each Cast

For each `as any` found, determine:

| Category | Risk | Action |
|----------|------|--------|
| **Structural mismatch** (string sent where array expected) | P0 - CRASH | Fix immediately |
| **Enum narrowing** (string sent where union expected) | P1 - Type safety | Type the state properly |
| **Return type access** (`(result as any).field`) | P1 - Type safety | Fix return type |
| **Cosmetic** (types match at runtime, cast for convenience) | P2 - Cleanup | Remove cast |

### 3.3 `as any` Audit Matrix

```markdown
| File:Line | Context | What's Cast | Category | Risk | Fix |
|-----------|---------|-------------|----------|------|-----|
| NewTaskSheet.tsx:151 | mutateAsync arg | department: string -> array | Structural | P0 | Wrap in [] |
```

---

## SECTION 4: NUMBER/DATE/BOOLEAN COERCION AUDIT

**Goal**: Verify all form fields are properly converted before sending to API.

### 4.1 Number Fields

```bash
# Find number inputs in forms
grep -rn 'type="number"\|type={"number"}\|amount\|price\|quantity\|hours\|weight' src/components/ src/app/ | grep -v node_modules
```

For each, verify:
- Is `parseFloat()` or `parseInt()` called before the API call?
- Does the backend expect `z.number()` or `z.string()`?
- Could the conversion produce `NaN`? Is that handled?

### 4.2 Date Fields

```bash
# Find date fields
grep -rn "DatePicker\|type=\"date\"\|toISOString\|due_date\|start_date\|end_date" src/components/ src/app/ | grep -v node_modules
```

For each, verify:
- Is the date converted to ISO string before the API call?
- Does the backend expect `z.string().datetime()` or `z.date()`?
- Are null dates handled? (`undefined` vs `null` vs empty string)

### 4.3 Boolean Fields

```bash
# Find boolean/toggle fields
grep -rn "is_active\|enabled\|checked\|toggle\|Switch\|Checkbox" src/components/ src/app/ | grep -v node_modules | head -30
```

For each, verify:
- Is a string `"true"/"false"` being sent where boolean is expected?
- Are checkbox values properly typed?

### 4.4 Coercion Audit Matrix

```markdown
| File:Line | Field | Form Type | API Type | Conversion | OK? |
|-----------|-------|-----------|----------|------------|-----|
| new/page.tsx:125 | estimated_hours | string (input) | z.number() | parseFloat() | YES |
```

---

## SECTION 5: RETURN TYPE / SERIALIZATION AUDIT

**Goal**: Verify API responses can be serialized (no BigInt, Decimal, or circular references).

### 5.1 BigInt Serialization

```bash
# Find BigInt usage
grep -rn "BigInt\|bigint" src/server/api/routers/
```

Verify: Are BigInt values converted to `Number()` before return?

### 5.2 Decimal Serialization

```bash
# Find Decimal usage (Prisma)
grep -rn "Decimal\|decimal\|convertDecimalToNumber" src/server/api/routers/
```

Verify: Are Decimal columns converted before return?

### 5.3 Date Serialization

```bash
# Find Date returns
grep -rn "new Date()\|Date.now()" src/server/api/routers/
```

Verify: Are dates returned as ISO strings (not Date objects)?

---

## SECTION 6: ENUM VALUE ALIGNMENT

**Goal**: Verify enum values in frontend match enum values in backend and database.

### 6.1 Find All Enum Definitions

```bash
# Backend enums
grep -rn "z\.enum(\[" src/server/api/routers/ | head -40

# Frontend enums
grep -rn "z\.enum(\[" src/components/ src/app/ | head -40
```

### 6.2 Compare Enum Values

For each enum field used in both frontend and backend:
- Do the allowed values match exactly?
- Is the frontend using a value that the backend doesn't accept?
- Has a new enum value been added to the backend but not the frontend (or vice versa)?

---

## SECTION 7: QUERY PARAMETER TYPE VERIFICATION

**Goal**: Verify filter/query parameters match between frontend and backend.

### 7.1 Find All useQuery Calls with Parameters

```bash
# Find parameterized queries
grep -rn "useQuery(" src/components/ src/app/ | grep -v "enabled\|refetch" | head -30
```

### 7.2 Compare Query Inputs

For each useQuery with parameters:
- Does the frontend send the correct types?
- Are enum filters typed properly (not `string`)?
- Are UUID parameters validated?
- Are pagination params (limit, offset) numbers (not strings)?

---

## SECTION 8: RECURRING PATTERN DETECTION

**Goal**: Find systematic patterns of type mismatches that affect multiple files.

### 8.1 Structural Cast Patterns

```bash
# Find the currentUser as any pattern
grep -rn "(currentUser as any)" src/
grep -rn "(data\?\.entity as any)" src/
```

**These indicate a missing return type** on the procedure. Fix at the source (add return type) to fix all consumers.

### 8.2 `useState<string>` for Enum Filters

```bash
# Find string state used for enum filters
grep -rn "useState<string>" src/app/ src/components/ | grep -i "filter\|status\|type\|category"
```

**These should be typed as the proper union** to eliminate `as any` at the call site.

### 8.3 Missing `.transform()` or `.preprocess()` in Schemas

```bash
# Find schemas that might need transforms
grep -rn "z\.preprocess\|z\.transform\|z\.coerce" src/server/api/routers/
```

---

## OUTPUT FORMAT

### Type Mismatch Audit Report

```markdown
## MASSU TYPE MISMATCH AUDIT REPORT

### Date: [timestamp]
### Scope: [Full / Specific router]

### Summary

| Section | Issues Found | P0 | P1 | P2 |
|---------|-------------|----|----|-----|
| 1. Array columns | N | N | N | N |
| 2. Schema comparison | N | N | N | N |
| 3. as any casts | N | N | N | N |
| 4. Coercion gaps | N | N | N | N |
| 5. Serialization | N | N | N | N |
| 6. Enum alignment | N | N | N | N |
| 7. Query parameters | N | N | N | N |
| 8. Recurring patterns | N | N | N | N |
| **TOTAL** | **N** | **N** | **N** | **N** |

### P0 Issues (Runtime Crashes)

| # | File:Line | Issue | Fix |
|---|-----------|-------|-----|
| 1 | [file:line] | [string sent to array column] | [wrap in array] |

### P1 Issues (Type Safety)

| # | File:Line | Issue | Fix |
|---|-----------|-------|-----|
| 1 | [file:line] | [as any hiding mismatch] | [type state properly] |

### P2 Issues (Cleanup)

| # | File:Line | Issue | Fix |
|---|-----------|-------|-----|
| 1 | [file:line] | [unnecessary cast] | [remove as any] |

### Verified Correct (No Issues)

- [Area]: [description of what was checked and passed]

### TYPE MISMATCH AUDIT STATUS: PASS / FAIL
```

---

## SESSION STATE UPDATE

After audit, update `session-state/CURRENT.md`:

```markdown
## TYPE MISMATCH AUDIT SESSION

### Audit
- **Date**: [timestamp]
- **Scope**: Full / [specific area]

### Findings
- P0 (crashes): [N]
- P1 (type safety): [N]
- P2 (cleanup): [N]
- Total: [N]

### Fixes Applied
[List or "None - audit only, plan saved for review"]

### Status
- Build: PASS/FAIL
- Type check: PASS/FAIL
```

---

## WHEN TO RUN

- After ANY schema migration (new columns, type changes)
- After adding new API procedures
- After adding new form components
- Before major releases
- When debugging "Expected X, received Y" Zod errors
- When debugging 400/500 errors on form submissions
- As part of periodic codebase audits

---

## SUBAGENT STRATEGY

For a full codebase audit, use parallel subagents to maximize coverage:

1. **Subagent 1**: Sections 1-2 (Array columns + Schema comparison)
2. **Subagent 2**: Sections 3-4 (`as any` casts + Coercion)
3. **Subagent 3**: Sections 5-6 (Serialization + Enum alignment)
4. **Subagent 4**: Sections 7-8 (Query params + Recurring patterns)

Merge results into single report.

---

## AUTO-LEARNING PROTOCOL (MANDATORY after every fix/finding)

**After EVERY fix or finding, the system MUST automatically learn. This is NOT optional.**

### Step 1: Ingest into Memory
Use `massu_memory_ingest` with type="bugfix"|"pattern", description of what was found/fixed, affected files, and importance (5=security/data, 3=build/type, 2=cosmetic).

### Step 2: Record Correct vs Incorrect Pattern
Update `memory/MEMORY.md` with the WRONG vs CORRECT pattern discovered.

### Step 3: Add to Pattern Scanner (if grep-able)
If the bad pattern is detectable by grep, add check to pattern scanner.

### Step 4: Search Codebase-Wide (CR-9)
`grep -rn "[bad_pattern]" src/` - fix ALL instances of the same issue.

---

## START NOW

1. Query database for ALL array columns (Section 1)
2. Inventory frontend form schemas (Section 2)
3. Find ALL `as any` in API contexts (Section 3)
4. Check number/date/boolean coercion (Section 4)
5. Verify serialization safety (Section 5)
6. Compare enum values (Section 6)
7. Check query parameter types (Section 7)
8. Detect recurring patterns (Section 8)
9. Produce Type Mismatch Audit Report
10. Save fix plan if issues found
11. Update session state

**Remember: `as any` is a red flag, not a solution. Every cast hides a potential runtime crash.**
