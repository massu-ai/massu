---
name: massu-simplify
description: Enhanced code simplification with parallel efficiency, reuse, and pattern compliance analysis
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-simplify

# Massu Simplify: Enhanced Code Quality Analysis

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

---

## Workflow Position

```
Code changes → /massu-simplify → /massu-commit → /massu-push
                    OR
/massu-loop → /massu-simplify → /massu-commit → /massu-push
                    OR
/massu-batch → /massu-simplify → /massu-commit → /massu-push
```

**This command is SUPPLEMENTAL — it runs AFTER implementation, BEFORE commit.**
**It is NOT a replacement for /massu-verify or /massu-commit. It adds efficiency, reuse, and semantic pattern analysis that those commands don't cover.**

---

## What This Command Catches (That Existing Tools Don't)

| Category | Example | Caught By Existing Tools? |
|----------|---------|--------------------------|
| Unnecessary async | `async` on functions with no `await` | NO |
| Redundant type assertions | `as T` when type is already inferred | NO |
| Code duplication | Inline `parseTier()` when `packages/core/src/` exports it | Partially (pattern-scanner) |
| Inefficient collections | `Array.find()` in a loop instead of building a Map | NO |
| Config hardcoding | Literal values instead of `getConfig()` | NO |
| Missing type exports | Types defined but not exported from barrel | NO |
| Unnecessary Map/Set | Using Map/Set where a plain object suffices | NO |
| Dead parameters | Function parameters that are never read | NO |

---

## EXECUTION PROTOCOL

### Step 1: Identify Changed Files

```bash
# Check for unstaged changes
git diff --name-only HEAD

# Check for staged changes
git diff --name-only --cached

# If no uncommitted changes, check last commit
git diff --name-only HEAD~1
```

**If no changes found**: Output "No changes detected. Make code changes first, then run /massu-simplify." and STOP.

Filter to only `.ts`, `.tsx`, `.js`, `.jsx` files. Exclude `node_modules/`, `.next/`, `dist/`.

### Step 2: Fast Gate — Pattern Scanner

```bash
bash scripts/massu-pattern-scanner.sh
```

If violations found: **Fix them ALL before proceeding.** Pattern scanner violations are syntactic anti-patterns that should be resolved before semantic analysis begins.

### Step 3: Parallel Review Phase (Principle #20 — One Task Per Agent)

Spawn 3 review agents **IN PARALLEL**. Each gets the list of changed files and a focused concern.

```
CHANGED_FILES = [list from Step 1]

efficiency_result = Agent(subagent_type="general-purpose", model="haiku", prompt="
  You are an EFFICIENCY REVIEWER for the Massu codebase (npm package).

  Review ONLY these changed files: {CHANGED_FILES}

  Check for these specific inefficiency patterns:

  1. UNNECESSARY ASYNC/AWAIT
     - async functions with no await (should be synchronous)
     - await on non-Promise values
     - Unnecessary Promise.resolve() wrapping synchronous values
     - Sequential awaits that could be Promise.all()

  2. REDUNDANT TYPE ASSERTIONS
     - `as T` when TypeScript already infers the correct type
     - Double assertions (`as unknown as T`) that indicate a design problem
     - Non-null assertions (`!`) on values that are already narrowed
     - Type assertions that could be replaced with type guards

  3. ALGORITHMIC INEFFICIENCY
     - O(n^2) patterns (nested loops, repeated .find() in .map())
     - Repeated string concatenation in loops (use array + join)
     - Sorting or filtering the same array multiple times
     - Using Array.find() in a loop instead of building a Map/Set lookup

  4. INEFFICIENT MAP/SET USAGE
     - Map<string, T> where a plain Record<string, T> suffices
     - Creating a Map/Set for single-use lookups
     - Not using Map when doing repeated key lookups on arrays

  5. GENERAL INEFFICIENCY
     - Loading full objects when only a subset of fields is needed
     - Repeated computation that could be cached in a local variable
     - Unnecessary spread/destructure creating shallow copies for no reason

  For each finding, return:
  FILE: [path]
  LINE: [number]
  SEVERITY: CRITICAL | HIGH | MEDIUM | LOW
  PATTERN: [which pattern from above]
  CURRENT: [the inefficient code]
  SUGGESTED: [the efficient replacement]

  If no findings: return EFFICIENCY_FINDINGS: 0
  Otherwise: return EFFICIENCY_FINDINGS: [count]
")

reuse_result = Agent(subagent_type="general-purpose", model="haiku", prompt="
  You are a REUSE REVIEWER for the Massu codebase (npm package).

  Review ONLY these changed files: {CHANGED_FILES}

  Search the codebase for existing utilities that the changed code should use instead of inline implementations. Check for:

  1. KNOWN UTILITIES (check if changed code duplicates these)
     - getConfig() → for config-driven values (never hardcode)
     - parseTier() → for tier string parsing
     - formatDuration() → for time/duration formatting
     - validateSchema() → for schema validation

  2. COMPONENT DUPLICATION
     - Search packages/core/src/ for existing modules
       that do the same thing as newly created modules
     - Check if a new utility duplicates an existing pattern

  3. PATTERN DUPLICATION
     - Same data transformation pattern written in multiple new files
     - Same validation logic duplicated
     - Same error handling pattern repeated
     - Same config access pattern inlined instead of using getConfig()

  For each finding, return:
  FILE: [path]
  LINE: [number]
  SEVERITY: HIGH | MEDIUM | LOW
  EXISTING_UTILITY: [import path and function name]
  CURRENT: [the duplicated code]
  SUGGESTED: [how to use the existing utility instead]

  If no findings: return REUSE_FINDINGS: 0
  Otherwise: return REUSE_FINDINGS: [count]
")

pattern_result = Agent(subagent_type="general-purpose", model="haiku", prompt="
  You are a PATTERN COMPLIANCE REVIEWER for the Massu codebase (npm package).

  Review ONLY these changed files: {CHANGED_FILES}

  Check for SEMANTIC pattern violations that the pattern-scanner (grep-based) cannot catch:

  1. ESM IMPORT COMPLIANCE
     - Using require() instead of ESM import (except in config files)
     - Missing file extensions in relative imports where required
     - Default exports where named exports should be used
     - Circular import chains between modules

  2. CONFIG-DRIVEN PATTERN VIOLATIONS
     - Hardcoded values that should come from getConfig()
     - Magic numbers/strings without named constants
     - Environment-specific logic not gated by config
     - Missing fallback defaults for config lookups

  3. TYPESCRIPT STRICT MODE VIOLATIONS
     - Implicit any types (missing type annotations on public APIs)
     - Using any when a proper type exists
     - Missing return type annotations on exported functions
     - Non-exhaustive switch/case on union types (missing default or case)

  4. TYPE EXPORT PATTERN VIOLATIONS
     - Types defined in a module but not exported from barrel index
     - Re-exporting types without using `export type` (isolatedModules)
     - Internal types leaked through public API surface
     - Missing JSDoc on exported types/interfaces

  5. SECURITY PATTERN VIOLATIONS
     - Unsanitized user input passed to dangerous operations
     - Missing input validation on public-facing functions
     - Secrets or credentials hardcoded in source

  6. ARCHITECTURAL VIOLATIONS
     - Cross-package imports bypassing barrel exports
     - Tight coupling between modules that should be independent
     - Side effects in module-level scope (top-level await, global mutations)

  For each finding, return:
  FILE: [path]
  LINE: [number]
  SEVERITY: CRITICAL | HIGH | MEDIUM | LOW
  RULE: [CR-XX or pattern name]
  CURRENT: [the violating code]
  SUGGESTED: [the compliant code]

  If no findings: return PATTERN_FINDINGS: 0
  Otherwise: return PATTERN_FINDINGS: [count]
")
```

### Step 4: Collect and Apply

1. Parse all 3 agent results
2. Combine findings into a single list, sorted by SEVERITY (CRITICAL first)
3. Apply ALL fixes:
   - CRITICAL and HIGH: Fix immediately
   - MEDIUM: Fix immediately
   - LOW: Fix immediately (CR-9: fix ALL issues encountered)
4. Show each fix applied with before/after

### Step 5: Re-verify

```bash
bash scripts/massu-pattern-scanner.sh
```

Confirm no new violations were introduced by the fixes.

### Step 6: Output Structured Result

```markdown
## /massu-simplify Results

**Files analyzed**: N
**Time**: Xs

| Dimension | Findings | Fixed | Remaining |
|-----------|----------|-------|-----------|
| Efficiency | N | N | 0 |
| Reuse | N | N | 0 |
| Pattern Compliance | N | N | 0 |
| Pattern Scanner | N | N | 0 |
| **Total** | **N** | **N** | **0** |

SIMPLIFY_GATE: PASS

### Changes Applied
- [file:line] — [description of fix]
- [file:line] — [description of fix]
...

### Next Steps
Run /massu-commit to commit verified code.
```

If any findings could NOT be fixed automatically:

```
SIMPLIFY_GATE: FAIL — N issues require manual resolution

### Manual Resolution Needed
- [file:line] — [why it couldn't be auto-fixed]
```

---

## RELATIONSHIP WITH OTHER COMMANDS

| Command | When | What |
|---------|------|------|
| `/massu-simplify` | After code changes, before commit | Efficiency + reuse + semantic patterns |
| `/massu-verify` | During /massu-loop audit phase | Full VR-* verification with plan coverage |
| `/massu-commit` | Before committing | Fast blocking gates (types, build, scanner) |
| `/massu-push` | Before pushing | Full tests + regression |
| `massu-pattern-scanner.sh` | Auto-runs in /massu-commit | Syntactic anti-pattern grep |

**Key distinction**: `/massu-simplify` catches SEMANTIC issues (inefficient algorithms, missed reuse opportunities, architectural anti-patterns) while `massu-pattern-scanner.sh` catches SYNTACTIC issues (forbidden imports, known bad patterns, deprecated APIs).
