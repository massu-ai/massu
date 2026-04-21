---
name: massu-simplify
description: "When user says 'simplify', 'review my code', 'clean this up', or has finished implementation and wants quality review before commit"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-simplify

# Massu Simplify: Enhanced Code Quality Analysis

**Shared rules**: Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

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
| Inefficient queries | `findMany().length` instead of SQL COUNT | NO |
| Unnecessary state | `useState` for derived values | NO |
| Code duplication | Inline `formatFileSize()` when `@/lib/formatting/fields` exists | Partially (pattern-scanner) |
| Over-fetching | `findMany()` without `select:` or `take:` | Partially (IN clause only) |
| Re-render waste | Missing `useMemo`/`useCallback` for expensive operations | NO |
| Existing utility ignorance | Rewriting a utility that already exists in shared code | NO |
| Memory leaks | Missing cleanup in `useEffect` | NO |
| Derived state anti-pattern | `useEffect` → `setState` for values derivable from props/queries | NO |

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
./scripts/pattern-scanner.sh
```

If violations found: **Fix them ALL before proceeding.** Pattern scanner violations are syntactic anti-patterns that should be resolved before semantic analysis begins.

### Step 3: Parallel Review Phase (Principle #20 — One Task Per Agent)

Spawn 3 review agents **IN PARALLEL**. Each gets the list of changed files and a focused concern.

```
CHANGED_FILES = [list from Step 1]

efficiency_result = Agent(subagent_type="general-purpose", model="haiku", prompt="
  You are an EFFICIENCY REVIEWER for the Massu codebase.

  Review ONLY these changed files: {CHANGED_FILES}

  Check for these specific inefficiency patterns:

  1. QUERY INEFFICIENCY
     - findMany().length or .filter().length instead of SQL COUNT/aggregate
     - Loading full records when only IDs or counts are needed
     - Missing take: limit on findMany (unbounded queries)
     - N+1 patterns: querying in a loop instead of batch IN clause
     - SELECT * (no select: clause) when only a few columns are needed

  2. REACT INEFFICIENCY
     - useState for values derivable from props or query data
     - useEffect → setState for derived state (should compute inline or useMemo)
     - Missing useMemo for expensive computations in render
     - Missing useCallback for functions passed as props to children
     - Unnecessary re-renders from object/array literals in JSX props

  3. ALGORITHMIC INEFFICIENCY
     - O(n²) patterns (nested loops, repeated .find() in .map())
     - Repeated string concatenation in loops (use array + join)
     - Sorting or filtering the same array multiple times

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
  You are a REUSE REVIEWER for the Massu codebase.

  Review ONLY these changed files: {CHANGED_FILES}

  Search the codebase for existing utilities that the changed code should use instead of inline implementations. Check for:

  1. KNOWN UTILITIES (check if changed code duplicates these)
     - Search the project for existing utility functions (formatters, validators, sanitizers)
     - Check shared/common directories for reusable helpers
     - Look for canonical imports in existing code (e.g., `import { x } from '@/lib/...'`)
     - Identify any inline implementations that duplicate existing utilities
     - Check for deprecated aliases that should use the canonical import

  2. COMPONENT DUPLICATION
     - Search src/components/shared/ and src/components/ui/ for existing components
       that do the same thing as newly created components
     - Check if a new modal/dialog/drawer duplicates an existing pattern

  3. PATTERN DUPLICATION
     - Same data fetching pattern written in multiple new files
     - Same form validation logic duplicated
     - Same error handling pattern repeated

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
  You are a PATTERN COMPLIANCE REVIEWER for the Massu codebase.

  Review ONLY these changed files: {CHANGED_FILES}

  Check for SEMANTIC pattern violations that the pattern-scanner.sh (grep-based) cannot catch:

  1. REACT QUERY v5 VIOLATIONS
     - Using onSuccess/onError/onSettled in useQuery options (removed in v5)
     - Not destructuring data from useQuery result
     - Using queryData?.find() in save handlers instead of checking record.id

  2. DATABASE PATTERN VIOLATIONS
     - Using raw SQL or ORM calls instead of project-standard query helpers
     - Accessing tables through wrong aliases or deprecated accessors
     - Missing type coercion wrappers on return values (e.g., BigInt → Number())
     - Using eager-loading patterns the ORM ignores (check project conventions)
     - Missing null-coercion helpers for UPDATE forms with clearable fields

  3. UI PATTERN VIOLATIONS
     - Select.Item with value='' (must use '__none__' or semantic value)
     - Missing loading/error/empty states in data-fetching components
     - Missing Suspense boundary for pages using use(params) or useSearchParams
     - Using onClick instead of onPointerDown for stylus-compatible interactions
     - Null-unsafe .replace()/.toLowerCase()/.charAt() on nullable strings

  4. SECURITY PATTERN VIOLATIONS
     - orderBy accepting z.string() instead of z.enum() with known columns
     - Using process.env.API_KEY before getCredentials() (CR-5 precedence)
     - publicProcedure on mutations (must be protectedProcedure)
     - Missing CRON_SECRET guard (if (!cronSecret) check before comparison)

  5. ARCHITECTURAL VIOLATIONS
     - Scoped queries without going through link table first
     - Full table loads for aggregate calculations (use SQL aggregates)
     - Client components importing server-only modules (@/lib/db)

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

### Step 3.5: Cross-Review Exchange (Debate Round)

**Skip condition**: If ALL three agents returned 0 findings, skip to Step 4.

If total findings > 0, spawn a single cross-reviewer agent:

```
Agent(subagent_type="general-purpose", model="haiku", prompt="
  You are a cross-reviewer for a code quality analysis. Three independent reviewers have analyzed the same codebase changes. Your job is to find interactions between their findings that no single reviewer could catch alone.

  ## Reviewer Findings
  EFFICIENCY: {efficiency_result}
  REUSE: {reuse_result}
  PATTERN: {pattern_result}

  ## Your Analysis (3 dimensions)

  1. CONFLICTING RECOMMENDATIONS: Do any two reviewers suggest contradictory fixes? (e.g., one says extract a helper, another says inline the code)
  2. COMPOUNDING ISSUES: Do findings from different reviewers combine to reveal a bigger problem? (e.g., a reuse violation + a pattern violation in the same file = architectural gap)
  3. MISSED INTERACTIONS: Does fixing one reviewer's finding create a new issue for another? (e.g., extracting a function for reuse changes the pattern compliance)

  For each finding, report:
    CROSS_FINDING: [type: CONFLICT|COMPOUND|INTERACTION]
    FILES: [affected files]
    REVIEWERS: [which reviewers' findings interact]
    RECOMMENDATION: [what to do]

  If no cross-cutting issues found: return CROSS_FINDINGS: 0
  Otherwise: return CROSS_FINDINGS: [count]
")
```

Add any CROSS_FINDINGS to the fix queue in Step 4, sorted above individual findings.

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
./scripts/pattern-scanner.sh
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
| Cross-Review | N | N | 0 |
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
| `/massu-push` | Before pushing | Full tests + regression + schema sync |
| `pattern-scanner.sh` | Auto-runs in /massu-commit | Syntactic anti-pattern grep |

**Key distinction**: `/massu-simplify` catches SEMANTIC issues (inefficient algorithms, missed reuse opportunities, architectural anti-patterns) while `pattern-scanner.sh` catches SYNTACTIC issues (forbidden imports, known bad column names, deprecated APIs).

## Gotchas

- **Run AFTER implementation, not during** — simplification reviews completed work. Running mid-implementation creates confusion about what's "done"
- **Parallel subagents may conflict** — when multiple review agents run simultaneously, they may propose conflicting changes. The main thread resolves conflicts
- **Don't simplify what you haven't read** — every file being simplified must be read first to understand context. Blind refactoring breaks things
- **Pattern scanner runs automatically** — PostToolUse hooks will flag violations. Fix them, don't suppress them
- **Reuse over rewrite** — prefer importing existing utilities over writing new implementations
