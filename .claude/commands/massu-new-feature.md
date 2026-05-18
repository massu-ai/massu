---
name: massu-new-feature
description: Feature scaffolding with correct patterns pre-applied and verification gates
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-new-feature

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# Massu New Feature: Pattern-Compliant Feature Scaffolding

## Workflow Position

```
/massu-create-plan -> /massu-plan -> /massu-loop / /massu-new-feature -> /massu-commit -> /massu-push
(PLAN)              (AUDIT)        (IMPLEMENT)    (SCAFFOLD)          (COMMIT)        (PUSH)
```

**This command can be used standalone or as part of /massu-loop for feature scaffolding.**

---

## Objective

Scaffold new features with **all CLAUDE.md patterns pre-applied**, ensuring correct architecture from the start. Verify each component before proceeding.

---

## NON-NEGOTIABLE RULES

- **Read CLAUDE.md first** - Know the patterns before writing code
- **Load domain patterns** - Read relevant pattern files
- **Verify each step** - VR-* checks after each component
- **No shortcuts** - Every feature needs all layers properly built
- **Pattern scanner must pass** - Before any commit
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - If ANY issue is discovered during feature development - whether from current changes OR pre-existing - fix it immediately. "Not in scope" and "pre-existing" are NEVER valid reasons to skip a fix. When fixing a bug, search entire codebase for same pattern and fix ALL instances.

---

## ZERO-GAP AUDIT LOOP

**Feature implementation does NOT complete until a SINGLE COMPLETE AUDIT finds ZERO issues.**

### The Rule

```
FEATURE VERIFICATION LOOP:
  1. Implement feature component
  2. Run ALL verification checks (patterns, types, build, tests)
  3. Count issues found
  4. IF issues > 0:
       - Fix ALL issues
       - Re-run ENTIRE verification from Step 2
  5. IF issues == 0:
       - Component verified, proceed to next
  6. After ALL components: Final full audit
  7. IF final audit gaps > 0:
       - Fix ALL gaps
       - Re-run ENTIRE final audit
  8. IF final audit gaps == 0:
       - FEATURE COMPLETE
```

### Completion Requirement

| Scenario | Action |
|----------|--------|
| Component fails verification | Fix issues, re-verify ENTIRE component |
| Final audit finds 2 issues | Fix both, re-run ENTIRE final audit |
| Final audit finds 0 issues | **NOW** feature complete |

**Partial verification is NOT valid. ALL checks must pass in a SINGLE run.**

---

## MANDATORY PATTERN ALIGNMENT GATE (PRE-SCAFFOLDING)

**BEFORE writing any code, verify the feature design aligns with ALL established patterns.**

### The Law

```
+-----------------------------------------------------------------------------+
|                                                                             |
|   EVERY NEW FEATURE MUST ALIGN WITH ESTABLISHED PATTERNS BEFORE CODING.    |
|   If no pattern exists, CREATE and SAVE it first (with user approval).     |
|   Writing code before pattern alignment = bugs designed into the feature.  |
|                                                                             |
+-----------------------------------------------------------------------------+
```

### Step 1: Read ALL Applicable Pattern Files

| Feature Type | Pattern Files to Read |
|--------------|----------------------|
| ANY feature | `.claude/CLAUDE.md` |
| Has MCP tools | Tool registration pattern in CLAUDE.md |
| Has hooks | Hook stdin/stdout pattern in CLAUDE.md |
| Has config changes | Config access pattern in CLAUDE.md |
| Has DB operations | SQLite database pattern in CLAUDE.md |

### Step 2: Build Pattern Alignment Matrix

```markdown
### FEATURE PATTERN ALIGNMENT: [Feature Name]

| Pattern ID | Pattern Requirement | Applies to Feature | How Feature Will Comply |
|------------|---------------------|-------------------|------------------------|
| TOOL-001 | 3-function registration pattern | YES/NO | [approach] |
| TOOL-002 | Config-driven prefix | YES/NO | [approach] |
| TOOL-003 | Wire into tools.ts | YES/NO | [approach] |
| CONFIG-001 | Use getConfig() not direct YAML | YES/NO | [approach] |
| DB-001 | getMemoryDb() with try/finally | YES/NO | [approach] |
| DB-002 | getCodeGraphDb() read-only | YES/NO | [approach] |
| HOOK-001 | JSON stdin/stdout | YES/NO | [approach] |
| HOOK-002 | esbuild compatible | YES/NO | [approach] |
```

### Step 3: Identify Pattern Gaps

If the feature needs functionality with NO existing pattern:

```markdown
### NEW PATTERN NEEDED

| Aspect | Details |
|--------|---------|
| **Feature Need** | [What the feature requires] |
| **Existing Patterns Checked** | [List what was checked] |
| **Why Existing Don't Work** | [Specific reasons] |
| **Proposed New Pattern** | [Description] |

**WRONG (Never Do This):**
```[code example]```

**CORRECT (Always Do This):**
```[code example]```

**Error if violated:**
[What breaks]
```

### Step 4: If New Pattern Needed

1. **Present to user for approval**
2. **Save to appropriate location BEFORE implementation**
3. **Reference saved pattern** in feature design

### Pattern Alignment Gate Verification

```markdown
### PATTERN ALIGNMENT GATE

| Check | Status |
|-------|--------|
| Read ALL applicable pattern files | YES/NO |
| Built Pattern Alignment Matrix | YES/NO |
| All applicable patterns have compliance approach | YES/NO |
| New patterns (if any) approved and saved | YES/NO |

**PATTERN ALIGNMENT GATE: PASS / FAIL**

If FAIL: Cannot begin implementation until all patterns addressed.
```

---

## FEATURE CHECKLIST

Before starting, determine what the feature needs:

```markdown
### Feature: [FEATURE_NAME]

#### Components Needed
- [ ] Tool module file (packages/core/src/[feature].ts)
- [ ] Tool definitions (getXToolDefinitions)
- [ ] Tool name matcher (isXTool)
- [ ] Tool handler (handleXToolCall)
- [ ] Wire into tools.ts
- [ ] Input schemas
- [ ] Config integration
- [ ] Tests (packages/core/src/__tests__/[feature].test.ts)
- [ ] Documentation

#### Patterns to Apply (MANDATORY)

**Tool Registration Patterns:**
- [ ] 3-function pattern (getDefs + isTool + handleCall)
- [ ] Config-driven tool prefix via getConfig().toolPrefix
- [ ] Wire definitions into getToolDefinitions() in tools.ts
- [ ] Wire handler into handleToolCall() in tools.ts
- [ ] stripPrefix() for base name matching

**Database Patterns:**
- [ ] getMemoryDb() with try/finally for memory operations
- [ ] getCodeGraphDb() for read-only CodeGraph queries
- [ ] getDataDb() for data DB operations
- [ ] Never write to CodeGraph DB

**Config Patterns:**
- [ ] getConfig() from config.ts (never parse YAML directly)
- [ ] Config-driven values (no hardcoding)

**Hook Patterns (if applicable):**
- [ ] JSON stdin/stdout
- [ ] esbuild compatible imports
- [ ] Exit within 5 seconds
- [ ] No heavy dependencies
```

---

## DOMAIN-SPECIFIC PATTERN LOADING

Based on feature type, load relevant patterns from CLAUDE.md:

| Domain | Section | Load When |
|--------|---------|-----------|
| Tool modules | Tool Registration Pattern | Adding MCP tools |
| Hooks | Hook stdin/stdout Pattern | Adding hooks |
| Config | Config Access Pattern | Changing config |
| Database | SQLite Database Pattern | Adding DB operations |

---

## COMPONENT REUSE REQUIREMENTS

**Before creating ANY new module, you MUST check for existing modules.**

### 1. Search for Existing Modules
```bash
# Find similar modules by name
ls packages/core/src/*[feature]* 2>/dev/null

# Find modules with similar functionality
grep -rln "[functionality]" packages/core/src/ | head -20

# Check existing tool modules
grep "ToolDefinitions" packages/core/src/*.ts
```

### 2. Reuse Priority
| Priority | Action |
|----------|--------|
| 1st | Use existing module as-is |
| 2nd | Extend existing module with new tools |
| 3rd | Compose from smaller existing modules |
| 4th | Create new module ONLY if nothing suitable exists |

### 3. Module Creation Checklist
Before creating new module:
- [ ] Searched for similar existing modules
- [ ] Checked if existing module can be extended
- [ ] Documented WHY new module is necessary

---

## PHASE 1: TOOL MODULE

### 1.1 Module Template
```typescript
// packages/core/src/[feature].ts
import { getConfig, stripPrefix } from './config.ts';
import type { ToolDefinition, ToolResult } from './types.ts';

export function getFeatureToolDefinitions(): ToolDefinition[] {
  const p = (name: string) => `${getConfig().toolPrefix}_${name}`;
  return [
    {
      name: p('feature_action'),
      description: 'Does the feature action',
      inputSchema: {
        type: 'object',
        properties: {
          param: { type: 'string', description: 'The parameter' },
        },
        required: ['param'],
      },
    },
  ];
}

export function isFeatureTool(name: string): boolean {
  const base = stripPrefix(name);
  return base.startsWith('feature_');
}

export function handleFeatureToolCall(
  name: string,
  args: Record<string, unknown>,
  memDb: Database.Database
): ToolResult {
  const baseName = stripPrefix(name);
  switch (baseName) {
    case 'feature_action':
      return { content: [{ type: 'text', text: 'result' }] };
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
}
```

### 1.2 Register in tools.ts
```typescript
// packages/core/src/tools.ts
import { getFeatureToolDefinitions, isFeatureTool, handleFeatureToolCall } from './[feature].ts';

// In getToolDefinitions():
...getFeatureToolDefinitions(),

// In handleToolCall():
if (isFeatureTool(name)) {
  const memDb = getMemoryDb();
  try { return handleFeatureToolCall(name, args, memDb); }
  finally { memDb.close(); }
}
```

### 1.3 Verify Tool Module
```bash
# Verify module exists
ls -la packages/core/src/[feature].ts

# Verify exports
grep -n "export.*function" packages/core/src/[feature].ts

# Verify registered in tools.ts
grep -n "getFeatureToolDefinitions\|isFeatureTool\|handleFeatureToolCall" packages/core/src/tools.ts

# Verify config-driven prefix
grep -n "getConfig().toolPrefix\|p(" packages/core/src/[feature].ts
```

---

## PHASE 2: TESTS

### 2.1 Test Template
```typescript
// packages/core/src/__tests__/[feature].test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getFeatureToolDefinitions, isFeatureTool, handleFeatureToolCall } from '../[feature].ts';

describe('[feature] tools', () => {
  it('should return tool definitions', () => {
    const defs = getFeatureToolDefinitions();
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0].name).toContain('feature_action');
  });

  it('should match tool names correctly', () => {
    expect(isFeatureTool('massu_feature_action')).toBe(true);
    expect(isFeatureTool('massu_other_action')).toBe(false);
  });
});
```

### 2.2 Verify Tests
```bash
# Run tests
npm test

# Verify test file exists
ls -la packages/core/src/__tests__/[feature].test.ts
```

---

## PHASE 3: VERIFICATION

### 3.1 Full Verification Suite
```bash
# Pattern scanner
bash scripts/massu-pattern-scanner.sh

# Type check
cd packages/core && npx tsc --noEmit

# Build (includes hook compilation)
npm run build

# Hook build
cd packages/core && npm run build:hooks

# Tests
npm test
```

### 3.2 Tool Registration Verification (VR-TOOL-REG)

**MANDATORY for any feature with new MCP tools:**

| Tool Item | Verification |
|-----------|--------------|
| Tool definitions exported | grep in module file |
| Tool matcher exported | grep in module file |
| Tool handler exported | grep in module file |
| Definitions spread in tools.ts | grep getXToolDefinitions |
| Handler wired in tools.ts | grep handleXToolCall |

### 3.3 Pattern Compliance
```bash
# All patterns must pass
bash scripts/massu-pattern-scanner.sh
# Expected: Exit 0
```

---

## FEATURE SCAFFOLDING REPORT

```markdown
## MASSU NEW FEATURE REPORT

### Feature: [NAME]
- **Date**: [timestamp]
- **Type**: [Tool Module / Hook / Config Extension]

### Components Created

#### Tool Module
- [ ] Module: packages/core/src/[feature].ts
- [ ] Tools: [list of tool names]
- [ ] Registered in tools.ts: YES

#### Tests
- [ ] Test file: packages/core/src/__tests__/[feature].test.ts
- [ ] All tests passing: YES

### Verification
| Check | Result | Status |
|-------|--------|--------|
| Pattern scanner | Exit 0 | PASS |
| Type check | 0 errors | PASS |
| Build | Exit 0 | PASS |
| Hook build | Exit 0 | PASS |
| Tests | ALL pass | PASS |

**FEATURE SCAFFOLDING COMPLETE**
```

---

## MANDATORY PLAN DOCUMENT UPDATE

**AFTER feature is complete, UPDATE the plan document with completion status.**

If this feature is part of a plan:
1. Open the plan document
2. Add/update completion table at TOP:

```markdown
# IMPLEMENTATION STATUS

**Plan**: [Plan Name]
**Status**: COMPLETE / IN_PROGRESS / PARTIAL
**Last Updated**: [YYYY-MM-DD HH:MM]

## Task Completion Summary

| # | Task/Phase | Status | Verification | Date |
|---|------------|--------|--------------|------|
| [N] | [This feature] | 100% COMPLETE | Dual Verification Gate PASS | [date] |
```

3. Record verification evidence:
```markdown
## Verification Evidence

### Feature: [Name]
- Dual Verification Gate: PASS
- Code Quality: Build, types, patterns all pass
- Plan Coverage: 100% items verified
```

---

## SESSION STATE UPDATE

After feature creation, update `session-state/CURRENT.md`:

```markdown
## NEW FEATURE SESSION

### Feature
- **Name**: [feature name]
- **Status**: COMPLETE

### Files Created
- [list of files]

### Verification
- All checks passed
```

---

## START NOW

1. Define feature requirements
2. Load relevant patterns from CLAUDE.md
3. Build pattern alignment matrix
4. Create tool module with 3-function pattern
5. Wire into tools.ts
6. Create tests
7. Run full verification suite
8. Update session state
9. Produce feature report

**Remember: Patterns from the start, not fixed later.**
