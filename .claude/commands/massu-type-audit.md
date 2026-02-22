---
name: massu-type-audit
description: Comprehensive type mismatch audit across module boundaries, config types, and runtime type safety
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Massu Type Audit: Comprehensive Type Safety Verification

## Objective

Audit the ENTIRE codebase for type mismatches between:
1. Module boundaries (exported types vs imported usage)
2. Config types and runtime code expectations
3. `as any` casts hiding real type issues
4. MCP tool input/output type contracts
5. Database schema types vs code types
6. Return type mismatches and serialization gaps

**This audit catches bugs that TypeScript CANNOT catch** - runtime validation failures, database type mismatches, and `as any` casts that hide structural mismatches.

---

## NON-NEGOTIABLE RULES

- **Trace the full path** - Config value -> getConfig() -> tool handler -> response
- **Verify against schema** - ALWAYS check type definitions for actual shapes
- **`as any` = suspect** - Every `as any` is a potential hidden mismatch
- **Show proof** - Every finding must include file:line and the exact mismatch

---

## ZERO-GAP AUDIT LOOP

**Type mismatch audit does NOT complete until a SINGLE COMPLETE AUDIT finds ZERO new issues.**

```
TYPE MISMATCH AUDIT LOOP:
  1. Run ALL audit sections
  2. Count total mismatches found
  3. IF mismatches > 0:
       - Document ALL mismatches
       - Fix ALL mismatches
       - Re-run ENTIRE audit from Section 1
  4. IF mismatches == 0:
       - TYPE SAFETY VERIFIED
```

---

## ARGUMENTS

This command accepts an optional scope argument:

- No argument: Full codebase audit (all sections)
- `tools`: Audit only MCP tool handlers
- `config`: Audit only config-related types
- `hooks`: Audit only hook type contracts
- `[module-name]`: Audit a specific module

---

## SECTION 1: MCP TOOL TYPE CONTRACTS

**Goal**: Verify all MCP tool input schemas match handler expectations.

### 1.1 Inventory All Tool Definitions

```bash
# Find all tool definition functions
grep -rn "getToolDefinitions\|ToolDefinition" packages/core/src/ --include="*.ts" | grep -v __tests__
```

### 1.2 For EACH Tool, Verify Input Schema Matches Handler

For every tool definition:
1. Check the `inputSchema.properties` definition
2. Find the corresponding handler function
3. Verify the handler destructures the same properties
4. Verify types match (string in schema = string in handler)

### 1.3 Tool Type Matrix

```markdown
| Module | Tool Name | Schema Props | Handler Expects | Match? |
|--------|-----------|-------------|-----------------|--------|
| [module] | [tool] | {a: string, b: number} | {a, b} | YES/NO |
```

---

## SECTION 2: CONFIG TYPE VERIFICATION

**Goal**: Verify config types match runtime expectations.

### 2.1 Check Config Type Definition

```bash
# Find config type/interface definitions
grep -rn "interface.*Config\|type.*Config" packages/core/src/config.ts
```

### 2.2 Verify Config Access Types

```bash
# Find all config property accesses and verify types
grep -rn "getConfig()\." packages/core/src/ --include="*.ts" | grep -v __tests__ | head -30
```

### 2.3 Config Type Matrix

```markdown
| Config Property | Defined Type | Used As | Match? | File:Line |
|----------------|-------------|---------|--------|-----------|
| toolPrefix | string | string | YES | config.ts:10 |
```

---

## SECTION 3: `as any` CAST AUDIT

**Goal**: Find ALL `as any` casts and determine if they hide real type mismatches.

### 3.1 Find All `as any` Casts

```bash
# Find all as any in source (excluding tests)
grep -rn "as any" packages/core/src/ --include="*.ts" | grep -v __tests__ | grep -v "\.d\.ts"
```

### 3.2 Categorize Each Cast

For each `as any` found, determine:

| Category | Risk | Action |
|----------|------|--------|
| **Structural mismatch** (wrong shape) | P0 - CRASH | Fix immediately |
| **Type narrowing** (known safe) | P1 - Type safety | Add proper type assertion |
| **Third-party interop** (SDK gaps) | P2 - Acceptable | Document reason |
| **Cosmetic** (types match at runtime) | P3 - Cleanup | Remove cast |

### 3.3 `as any` Audit Matrix

```markdown
| File:Line | Context | What's Cast | Category | Risk | Fix |
|-----------|---------|-------------|----------|------|-----|
```

---

## SECTION 4: DATABASE TYPE VERIFICATION

**Goal**: Verify SQLite column types match TypeScript expectations.

### 4.1 Find Schema Definitions

```bash
# Find CREATE TABLE statements
grep -rn "CREATE TABLE\|CREATE.*IF NOT EXISTS" packages/core/src/ --include="*.ts" | grep -v __tests__
```

### 4.2 Compare DB Types to Code Types

For each table:
1. Find the CREATE TABLE statement (column types)
2. Find all queries that read/write to that table
3. Verify TypeScript types match SQLite types

### 4.3 Database Type Matrix

```markdown
| Table | Column | DB Type | Code Type | Match? | File:Line |
|-------|--------|---------|-----------|--------|-----------|
```

---

## SECTION 5: RETURN TYPE / SERIALIZATION AUDIT

**Goal**: Verify MCP tool responses can be serialized and match expected formats.

### 5.1 Check Tool Return Types

```bash
# Find all tool handler return statements
grep -rn "return.*content.*type.*text" packages/core/src/ --include="*.ts" | grep -v __tests__ | head -20
```

### 5.2 Verify JSON Serialization Safety

```bash
# Find potential serialization issues
grep -rn "BigInt\|bigint\|circular\|undefined" packages/core/src/ --include="*.ts" | grep -v __tests__ | head -10
```

### 5.3 Serialization Matrix

```markdown
| Module | Tool | Return Value | Serializable? | Fix Needed? |
|--------|------|-------------|---------------|-------------|
```

---

## SECTION 6: ENUM / UNION VALUE ALIGNMENT

**Goal**: Verify enum/union values are consistent across module boundaries.

### 6.1 Find All Enum/Union Definitions

```bash
# Find type unions and enums
grep -rn "type.*=.*|\|enum " packages/core/src/ --include="*.ts" | grep -v __tests__ | head -30
```

### 6.2 Compare Values Across Modules

For each enum/union used across multiple files:
- Do the allowed values match exactly?
- Is one module using a value the other doesn't accept?

### 6.3 Enum Alignment Matrix

```markdown
| Type | Definition Location | Consumer Location | Values Match? |
|------|-------------------|-------------------|---------------|
```

---

## SECTION 7: FUNCTION SIGNATURE AUDIT

**Goal**: Verify exported function signatures match their usage across the codebase.

### 7.1 Find Exported Functions

```bash
# Find all exported functions
grep -rn "export function\|export async function\|export const.*=" packages/core/src/ --include="*.ts" | grep -v __tests__ | head -30
```

### 7.2 Verify Call Sites Match Signatures

For each exported function, check all call sites:
- Correct number of arguments?
- Correct argument types?
- Return value used correctly?

### 7.3 Signature Matrix

```markdown
| Function | Defined In | Called From | Args Match? | Return Used Correctly? |
|----------|-----------|------------|-------------|----------------------|
```

---

## SECTION 8: RECURRING PATTERN DETECTION

**Goal**: Find systematic patterns of type mismatches that affect multiple files.

### 8.1 Common Anti-Patterns

```bash
# Find Record<string, any> (often hides real types)
grep -rn "Record<string, any>" packages/core/src/ --include="*.ts" | grep -v __tests__

# Find unknown casts
grep -rn "as unknown" packages/core/src/ --include="*.ts" | grep -v __tests__

# Find type assertions that might be wrong
grep -rn "as [A-Z]" packages/core/src/ --include="*.ts" | grep -v __tests__ | head -20
```

---

## OUTPUT FORMAT

### Type Mismatch Audit Report

```markdown
## MASSU TYPE MISMATCH AUDIT REPORT

### Date: [timestamp]
### Scope: [Full / Specific module]

### Summary

| Section | Issues Found | P0 | P1 | P2 |
|---------|-------------|----|----|-----|
| 1. Tool contracts | N | N | N | N |
| 2. Config types | N | N | N | N |
| 3. as any casts | N | N | N | N |
| 4. Database types | N | N | N | N |
| 5. Serialization | N | N | N | N |
| 6. Enum alignment | N | N | N | N |
| 7. Function sigs | N | N | N | N |
| 8. Recurring patterns | N | N | N | N |
| **TOTAL** | **N** | **N** | **N** | **N** |

### P0 Issues (Runtime Crashes)

| # | File:Line | Issue | Fix |
|---|-----------|-------|-----|

### P1 Issues (Type Safety)

| # | File:Line | Issue | Fix |
|---|-----------|-------|-----|

### P2 Issues (Cleanup)

| # | File:Line | Issue | Fix |
|---|-----------|-------|-----|

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
[List or "None - audit only"]

### Status
- Build: PASS/FAIL
- Type check: PASS/FAIL (`cd packages/core && npx tsc --noEmit`)
```

---

## WHEN TO RUN

- After ANY schema changes (new tables, column type changes)
- After adding new MCP tools
- After modifying config types
- Before major releases
- When debugging runtime type errors
- As part of periodic codebase audits

---

## AUTO-LEARNING PROTOCOL (MANDATORY after every fix/finding)

**After EVERY fix or finding, the system MUST automatically learn. This is NOT optional.**

### Step 1: Record the Pattern
Document what went wrong and how it was fixed in session state.

### Step 2: Update Pattern Scanner (if detectable)
If the bad pattern is detectable by grep, consider adding a check to `scripts/massu-pattern-scanner.sh`.

### Step 3: Search Codebase-Wide (CR-9)
`grep -rn "[bad_pattern]" packages/core/src/` - fix ALL instances of the same issue.

---

## START NOW

1. Inventory MCP tool type contracts (Section 1)
2. Verify config types (Section 2)
3. Find ALL `as any` casts (Section 3)
4. Check database types (Section 4)
5. Verify serialization safety (Section 5)
6. Compare enum values (Section 6)
7. Audit function signatures (Section 7)
8. Detect recurring patterns (Section 8)
9. Produce Type Mismatch Audit Report
10. Update session state

**Remember: `as any` is a red flag, not a solution. Every cast hides a potential runtime crash.**
