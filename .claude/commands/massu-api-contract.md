---
name: massu-api-contract
description: MCP tool contract audit with handler-schema verification and consistency checks
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Massu API Contract: MCP Tool Audit Protocol

## Objective

Audit MCP tool definitions for **contract consistency** between tool schemas and handlers, verify tools follow patterns, and ensure type safety across tool boundaries.

---

## NON-NEGOTIABLE RULES

- **Pattern compliance** - All tools follow CLAUDE.md rules
- **Type safety** - Input schemas must match handler expectations
- **Tool registration** - ALL tools must be wired in tools.ts (CR-11)
- **Config-driven prefixes** - No hardcoded tool name prefixes
- **Verify all claims** - Show grep proof
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - If ANY issue is discovered during API contract audit - whether from current changes OR pre-existing - fix it immediately. "Not in scope" and "pre-existing" are NEVER valid reasons to skip a fix. When fixing a bug, search entire codebase for same pattern and fix ALL instances.

---

## ZERO-GAP AUDIT LOOP

**API contract audit does NOT complete until a SINGLE COMPLETE AUDIT finds ZERO issues.**

### The Rule

```
API AUDIT LOOP:
  1. Run ALL contract verification checks
  2. Count total violations/issues found
  3. IF issues > 0:
       - Fix ALL issues
       - Re-run ENTIRE audit from Step 1
  4. IF issues == 0:
       - API CONTRACT VERIFIED
```

### Completion Requirement

| Scenario | Action |
|----------|--------|
| Audit finds 4 pattern violations | Fix all 4, re-run ENTIRE audit |
| Re-audit finds 1 issue | Fix it, re-run ENTIRE audit |
| Re-audit finds 0 issues | **NOW** API contract verified |

**Partial re-checks are NOT valid. The ENTIRE API audit must pass in a SINGLE run.**

---

## AUDIT SECTION 1: TOOL MODULE INVENTORY

### 1.1 List All Tool Modules

```bash
# Find all tool definition files
grep -rln "getToolDefinitions\|ToolDefinition" packages/core/src/ --include="*.ts" | grep -v __tests__ | sort

# Count total tool modules
grep -rln "ToolDefinition" packages/core/src/ --include="*.ts" | grep -v __tests__ | wc -l
```

### 1.2 Tool Registration Matrix

```markdown
### Tool Registration Audit

| Module File | Imported in tools.ts | Definitions Spread | Handler Wired | Status |
|-------------|---------------------|-------------------|---------------|--------|
| [file].ts | YES/NO | YES/NO | YES/NO | OK/MISSING |
```

### 1.3 Find Unregistered Modules (CR-11)

```bash
# Get all modules exporting tool definitions
grep -rln "export.*get.*ToolDefinitions\|export.*get.*Definitions" packages/core/src/ --include="*.ts" | grep -v __tests__

# Compare with tools.ts imports
grep -n "import.*from" packages/core/src/tools.ts
```

---

## AUDIT SECTION 2: TOOL DEFINITION INVENTORY

### 2.1 List All Tool Definitions

```bash
# Find all tool name definitions
grep -rn "name:.*_\|name: \`" packages/core/src/ --include="*.ts" | grep -v __tests__ | grep -v "test\|spec"
```

### 2.2 Tool Definition Matrix

```markdown
### Tool Inventory

| Module | Tool Name | Input Schema | Required Props | Status |
|--------|-----------|-------------|----------------|--------|
| [module] | [name] | {props...} | [list] | OK/REVIEW |
```

### 2.3 Verify Config-Driven Prefixes

```bash
# Check for hardcoded tool prefixes (should use getConfig().toolPrefix)
grep -rn "'massu_\|\"massu_" packages/core/src/ --include="*.ts" | grep -v __tests__ | grep -v config | grep -v "\.test\."
# Expected: 0 matches (all prefixes should be dynamic)
```

---

## AUDIT SECTION 3: HANDLER-SCHEMA CONSISTENCY

### 3.1 Verify Input Schema Matches Handler

For each tool:
1. Extract `inputSchema.properties` from the definition
2. Find the handler function
3. Verify all required properties are destructured/used
4. Verify types match (string schema = string usage)

```bash
# Find input schema definitions
grep -rn "inputSchema" packages/core/src/ --include="*.ts" | grep -v __tests__ | head -20

# Find handler switch cases
grep -rn "case.*:" packages/core/src/ --include="*.ts" | grep -v __tests__ | grep -v "default:" | head -20
```

### 3.2 Schema-Handler Consistency Matrix

```markdown
### Schema-Handler Consistency

| Tool | Schema Property | Type | Handler Uses It | Match? |
|------|----------------|------|-----------------|--------|
| [tool] | [prop] | string | YES/NO | PASS/FAIL |
```

---

## AUDIT SECTION 4: PATTERN COMPLIANCE

### 4.1 Critical Pattern Checks

```bash
# P-001: ESM imports with .ts extensions
grep -rn "from '\.\./\|from '\.\/" packages/core/src/ --include="*.ts" | grep -v "\.ts'" | grep -v __tests__
# Expected: 0 matches

# P-002: Config-driven tool prefix
grep -rn "hardcoded.*massu\|'massu_" packages/core/src/ --include="*.ts" | grep -v __tests__ | grep -v config
# Expected: 0 matches

# P-003: getConfig() usage (not direct YAML parse)
grep -rn "yaml\.parse\|readFileSync.*config" packages/core/src/ --include="*.ts" | grep -v config.ts | grep -v __tests__
# Expected: 0 matches

# P-004: memDb lifecycle (try/finally with close)
grep -rn "getMemoryDb()" packages/core/src/ --include="*.ts" | grep -v __tests__ | head -10
# Verify each has corresponding .close() in finally block

# P-005: Pattern scanner passes
bash scripts/massu-pattern-scanner.sh
# Expected: Exit 0
```

### 4.2 Pattern Compliance Matrix

```markdown
### Pattern Compliance

| Pattern | Check | Result | Status |
|---------|-------|--------|--------|
| P-001 ESM extensions | grep | 0 matches | PASS |
| P-002 Config prefix | grep | 0 matches | PASS |
| P-003 Config access | grep | 0 matches | PASS |
| P-004 memDb lifecycle | grep | Review | REVIEW |
| P-005 Pattern scanner | script | Exit 0 | PASS |

**PATTERN COMPLIANCE: PASS/FAIL**
```

---

## AUDIT SECTION 5: OUTPUT CONSISTENCY

### 5.1 Check Return Types

```bash
# Find tool handler return patterns
grep -rn "return.*content.*type.*text" packages/core/src/ --include="*.ts" | grep -v __tests__ | head -20
```

### 5.2 Verify MCP Response Format

All tool handlers must return `{ content: [{ type: 'text', text: string }] }`.

```bash
# Find non-standard returns
grep -rn "return {" packages/core/src/ --include="*.ts" | grep -v "content:" | grep -v __tests__ | grep -v "type:" | head -10
```

---

## AUDIT SECTION 6: ERROR HANDLING

### 6.1 Check Error Handling in Handlers

```bash
# Find try-catch in tool handlers
grep -rn "try {" packages/core/src/ --include="*.ts" | grep -v __tests__ | wc -l

# Find error response patterns
grep -rn "catch\|error\|Error" packages/core/src/ --include="*.ts" | grep -v __tests__ | head -20
```

### 6.2 Error Handling Matrix

```markdown
### Error Handling Audit

| Module | Tools Count | Try-Catch | Error Response | Status |
|--------|------------|-----------|----------------|--------|
| [module] | N | N blocks | N handlers | OK/REVIEW |
```

---

## AUDIT SECTION 7: TYPE CHECK

### 7.1 Run TypeScript Compiler

```bash
cd packages/core && npx tsc --noEmit
# Expected: 0 errors
```

### 7.2 Run Tests

```bash
npm test
# Expected: ALL pass
```

---

## API CONTRACT REPORT FORMAT

```markdown
## MASSU API CONTRACT REPORT

### Summary
- **Date**: [timestamp]
- **Total Tool Modules**: [N]
- **Total Tools**: [N]
- **Critical Issues**: [N]

### Tool Registration (CR-11)
| Status | Count |
|--------|-------|
| Registered | N |
| Unregistered | N |

### Pattern Compliance
| Pattern | Result |
|---------|--------|
| P-001 ESM extensions | PASS/FAIL |
| P-002 Config prefix | PASS/FAIL |
| P-003 Config access | PASS/FAIL |
| P-004 memDb lifecycle | PASS/FAIL |
| P-005 Pattern scanner | PASS/FAIL |

### Issues Found
| Severity | Module | Issue | Fix |
|----------|--------|-------|-----|
| CRITICAL | [module] | [issue] | [fix] |

### Schema-Handler Sync
- Matched tools: N
- Schema mismatches: N
- Unregistered tools: N

### Recommendations
1. [Recommendation 1]
2. [Recommendation 2]

**API CONTRACT STATUS: HEALTHY / NEEDS ATTENTION / CRITICAL**
```

---

## SESSION STATE UPDATE

After audit, update `session-state/CURRENT.md`:

```markdown
## API CONTRACT AUDIT SESSION

### Audit
- **Date**: [timestamp]
- **Scope**: Full / [specific module]

### Findings
- Pattern violations: [N]
- Unregistered tools: [N]
- Schema mismatches: [N]
- Type errors: [N]

### Fixes Applied
[List or "None - audit only"]

### Status
- Pattern scanner: PASS/FAIL
- Type check: PASS/FAIL
- Tests: PASS/FAIL
```

---

## QUICK COMMANDS

```bash
# Quick pattern check
bash scripts/massu-pattern-scanner.sh

# Type check
cd packages/core && npx tsc --noEmit

# Run tests
npm test

# Build hooks
cd packages/core && npm run build:hooks

# Count all tools
grep -rn "name:.*_" packages/core/src/ --include="*.ts" | grep -v __tests__ | wc -l
```

---

## AUTO-LEARNING PROTOCOL (MANDATORY after every fix/finding)

**After EVERY fix or finding, the system MUST automatically learn. This is NOT optional.**

### Step 1: Record the Pattern
Document the wrong vs correct pattern in session state.

### Step 2: Add to Pattern Scanner (if detectable)
If the bad pattern is detectable by grep, add check to `scripts/massu-pattern-scanner.sh`.

### Step 3: Search Codebase-Wide (CR-9)
`grep -rn "[bad_pattern]" packages/core/src/` - fix ALL instances of the same issue.

---

## START NOW

1. Run Section 1: Tool Module Inventory
2. Run Section 2: Tool Definition Inventory
3. Run Section 3: Handler-Schema Consistency
4. Run Section 4: Pattern Compliance (CRITICAL)
5. Run Section 5: Output Consistency
6. Run Section 6: Error Handling
7. Run Section 7: Type Check
8. Produce API Contract Report
9. Update session state

**Remember: Pattern compliance is non-negotiable. All violations must be fixed.**
