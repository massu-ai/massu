---
name: massu-create-plan
description: "When user wants to plan a feature, fix, or change before implementing -- 'create a plan', 'plan this', or describes requirements that need scoping"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---
name: massu-create-plan

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-12 enforced.

> **Config lookup (framework-aware)**: This command reads `config.framework.type` and `config.verification.<primary_language>` from `massu.config.yaml` to choose the right verification commands. Hardcoded references below to `packages/core`, `tools.ts`, `vitest`, `VR-TOOL-REG`, and `VR-HOOK-BUILD` are **MCP-project specific** and only apply when `config.framework.type === 'mcp'` (or `languages.typescript.runtime === 'mcp'`). For other projects, substitute: type-check → `config.verification.<primary_language>.type`, tests → `.test`, build → `.build`, lint → `.lint`. See `.claude/reference/vr-verification-reference.md` for the config-driven VR-* catalog.

# Massu Create Plan: Reality-Based Plan Generation

## CRITICAL: THIS IS A PLAN-CREATION COMMAND, NOT AN IMPLEMENTATION COMMAND

**THIS COMMAND CREATES PLANS FOR USER REVIEW. IT DOES NOT IMPLEMENT ANYTHING.**

### FORBIDDEN Actions (Zero Tolerance)
- Writing code to source files (Edit/Write to packages/)
- Running npm install/build as implementation
- Creating modules, tools, or hooks
- Committing any changes
- Starting any implementation work

### REQUIRED Actions
- Research the codebase (Read, Grep, Glob)
- Read existing similar modules
- Write the PLAN DOCUMENT (Write to docs/plans/)
- Present plan for user approval
- **STOP AND WAIT** for explicit user approval

### AFTER PRESENTING PLAN: MANDATORY WAIT

**After presenting a plan summary, you MUST:**
1. **STOP completely** - Do not call any more tools
2. **WAIT** for the user to explicitly say "proceed", "implement", "approved", or similar
3. **Do NOT interpret ExitPlanMode's response as plan approval**

**ONLY these phrases mean you can implement:**
- "proceed with implementation"
- "implement the plan"
- "approved, go ahead"
- "start implementing"

### Command Distinction
| Command | Purpose | Implementation? |
|---------|---------|-----------------|
| `/massu-create-plan` | Create plan document | **NO - FORBIDDEN** |
| `/massu-plan` | Audit existing plan | **NO - FORBIDDEN** |
| `/massu-loop` | Implement plan with verification | **YES** |
| `/massu-simplify` | Post-change quality analysis | **YES** (fixes code) |
| `/massu-commit` | Commit after implementation | After implementation only |

**If you find yourself about to edit a source file, STOP. You are violating this protocol.**

---

## Workflow Position

```
/massu-create-plan -> /massu-plan -> /massu-loop -> /massu-commit -> /massu-push
(CREATE)           (AUDIT)        (IMPLEMENT)   (COMMIT)        (PUSH)
```

**This command is step 1 of 5 in the standard workflow.**

### Workflow State Tracking

Write a transition entry to `.massu/workflow-log.md`:
```
| [timestamp] | - | PLAN | /massu-create-plan | [session-id] |
```

---

## Objective

Create a comprehensive, feasible implementation plan by checking REAL file structure, reading REAL code, and aligning with ESTABLISHED patterns. The output is a plan that has been pre-verified for feasibility.

**Philosophy**: A plan written without checking reality is fiction. Read first, plan second.

---

## NON-NEGOTIABLE RULES

1. Read before referencing - never reference a file without reading it
2. Pattern compliance - every plan item must align with CLAUDE.md patterns
3. Enumerated items - every deliverable must be numbered and verifiable
4. Feasibility pre-check - plan items must be possible with current codebase state
5. No guessing - if uncertain, read the file or search the codebase

---

## PHASE 0: REQUIREMENTS INTERVIEW

### 0.1 Requirements Coverage Map (Initialize at Session Start)

Track which requirement dimensions have been explored. Initialize ALL as `pending`:

| # | Dimension | Status | Resolved By |
|---|-----------|--------|-------------|
| D1 | Problem & Scope | pending | User request + Phase 0 interview |
| D2 | Users & Personas | pending | Phase 0 interview |
| D3 | Architecture | pending | Phase 2 (Architecture Reality Check) |
| D4 | Module Design | pending | Phase 3 (Codebase Reality Check) |
| D5 | UX / API Surface | pending | Phase 3 + Phase 0 interview |
| D6 | Auth & Permissions | pending | Phase 4 (Pattern Compliance) |
| D7 | Error Handling | pending | Phase 4 (Pattern Compliance) |
| D8 | Security | pending | Phase 4.8 (Security Pre-Screen) |
| D9 | Edge Cases | pending | Phase 4.7 (Question Filtering) |
| D10 | Performance | pending | Phase 4 (Pattern Compliance) |

Mark each dimension `done` or `n/a` as the corresponding phase completes. Dimensions still `pending` after Phase 4.8 trigger a warning before plan generation.

### 0.2 Ambiguity Detection

Score the user's request against these 7 signals (1 point each):

| # | Signal | Example |
|---|--------|---------|
| A1 | Vague scope -- no clear boundary | "improve the MCP tools" |
| A2 | No success criteria -- no measurable outcome | "make it better" |
| A3 | Implicit requirements -- unstated but necessary | "add caching" (where? what data?) |
| A4 | Multi-domain -- spans 3+ domains | tools + hooks + config + tests |
| A5 | Contradictions -- conflicting constraints | "fast AND comprehensive" |
| A6 | No persona -- unclear who benefits | "add a dashboard" (admin? user?) |
| A7 | New integration -- external service not yet in codebase | "connect to Datadog" |

**Score >= 2**: Enter interview loop (Phase 0.3).
**Score 0-1**: Fast-track to Phase 0.5/1. Mark D1 as `done` from user request. Mark D2 as `done` if persona is obvious from context, otherwise `n/a`.

### 0.3 Interview Loop (When Triggered)

Ask one question at a time via AskUserQuestion. For each question:

1. **Show compact coverage status** before asking (inline: `Coverage: D1:done D2:pending D3:pending ...`)
2. **Provide 2-4 curated options** -- never open-ended "what do you want?"
3. **Push back on contradictions** -- if the user picks conflicting options, flag it: "Option A conflicts with your earlier choice of X. Which takes priority?"
4. **Push back on over-engineering** -- if scope expands beyond what's needed, flag it: "That adds [X] complexity. The simpler path is [Y]. Proceed with full scope or simplified?"
5. **Self-terminate** when all user-dependent dimensions (D1, D2, D5) are covered
6. **Escape hatch** -- if the user says "skip", "enough", or "just do it", stop immediately and mark remaining user dimensions as `n/a`

After the loop, mark D1, D2, D5 as `done` (or `n/a` if skipped). D3-D4, D6-D10 are resolved by later phases automatically.

### 0.4 Verbal Instruction Capture (MANDATORY after interview)

**After the interview loop completes (or is skipped), review the ENTIRE conversation for ANY user statements about:**
- Placement or location ("put it in the tools module", "alongside the memory tools")
- Module or route ("this goes in the config section", "on the dashboard page")
- Naming ("call it X", "the tool should be named Y")
- Architecture ("use a separate module", "make it a hook")
- Component choices ("use a Card layout", "DataTable with filters")

**Each such statement MUST become an explicit numbered plan item (P-XXX)** with:
- Exact module/file where it applies
- Exact file path for the implementation
- Insertion point within the file
- The user's exact words quoted as the specification

**Why**: Verbal instructions given during conversation are frequently lost during plan generation. If the user said "put the new tool in the memory module", that MUST appear as a plan item referencing the exact file, not a generic "add tool" item.

---

## PHASE 0.5: TEMPLATE SELECTION

Based on the user's request, check if a common pattern template applies. Templates are STARTING POINTS -- subsequent phases still verify feasibility and adjust details.

### Template Detection

Evaluate the request against these common patterns:

| Template | Trigger | Pre-filled Phases |
|----------|---------|-------------------|
| A: Dashboard Page | Request involves a new dashboard page/view | Migration -> Types -> Data Layer -> Server Actions -> Page + Client Component -> Nav Update -> Docs |
| B: API Endpoint | Request involves a new REST API endpoint | Route File -> Auth Middleware -> Input Validation -> Business Logic -> Rate Limiting -> Tests -> API Docs |
| C: MCP Tool Module | Request involves a new MCP tool | Module (3-function pattern) -> Wire into tools.ts -> Tests -> Config (if needed) |
| D: Edge Function | Request involves a Supabase edge function | Function File -> CORS Setup -> Auth -> Validation -> Business Logic -> Error Handling -> Cron Config |
| E: Feature Tier Addition | Request involves adding features to a pricing tier | Migration -> Types -> Data Layer -> Actions -> Pages -> Nav -> Pricing Update -> Feature Comparison -> FAQ -> Docs |

### TEMPLATE A: New Dashboard Page

If the request is for a new dashboard page:

```markdown
## Pre-filled Plan Structure (Dashboard Page)

### Phase 1: Database
- P1-001: Migration -- Create table with RLS, policies, indexes, triggers
- P1-002: Type sync -- Add type aliases to `website/src/lib/supabase/types.ts`

### Phase 2: Data Layer
- P2-001: Data access functions -- `website/src/lib/supabase/[FILL].ts`
- P2-002: Server actions -- `website/src/app/dashboard/[FILL]/actions.ts`

### Phase 3: UI
- P3-001: Page component -- `website/src/app/dashboard/[FILL]/page.tsx`
- P3-002: Client components -- `website/src/app/dashboard/[FILL]/[FILL]-client.tsx`
- P3-003: Loading state -- `website/src/app/dashboard/[FILL]/loading.tsx`

### Phase 4: Navigation & Docs
- P4-001: Update dashboard nav -- `website/src/components/dashboard/DashboardNav.tsx`
- P4-002: Update docs if needed
```

### TEMPLATE B: New API Endpoint

If the request is for a new API endpoint:

```markdown
## Pre-filled Plan Structure (API Endpoint)

### Phase 1: Route
- P1-001: Route file -- `website/src/app/api/[FILL]/route.ts`
- P1-002: Auth middleware -- `createServerSupabaseClient` or `authenticateApiKey`
- P1-003: Input validation -- Zod schema for request body/params

### Phase 2: Logic
- P2-001: Business logic implementation
- P2-002: Rate limiting -- `rateLimit()` integration
- P2-003: Error handling -- Consistent error response format

### Phase 3: Tests & Docs
- P3-001: API tests
- P3-002: API documentation update
```

### TEMPLATE C: New MCP Tool Module

If the request is for a new MCP tool:

```markdown
## Pre-filled Plan Structure (MCP Tool Module)

### Phase 1: Module
- P1-001: Tool module -- `packages/core/src/[FILL].ts`
  - `get[FILL]ToolDefinitions()` -- Returns tool definitions
  - `is[FILL]Tool(name)` -- Returns boolean for tool name matching
  - `handle[FILL]ToolCall(name, args, memDb)` -- Handles tool execution

### Phase 2: Registration
- P2-001: Wire into tools.ts -- Import + definitions + handler routing

### Phase 3: Tests
- P3-001: Test file -- `packages/core/src/__tests__/[FILL].test.ts`
  - Test definitions, matching, handler

### Phase 4: Config (if needed)
- P4-001: Config interface -- Add to `config.ts` + `massu.config.yaml`
```

### TEMPLATE D: New Edge Function

If the request is for a Supabase edge function:

```markdown
## Pre-filled Plan Structure (Edge Function)

### Phase 1: Function
- P1-001: Function file -- `website/supabase/functions/[FILL]/index.ts`
- P1-002: CORS setup -- Standard CORS headers for the function
- P1-003: Auth -- Verify JWT or API key

### Phase 2: Logic
- P2-001: Input validation -- Parse and validate request body
- P2-002: Business logic -- Core function implementation
- P2-003: Error handling -- Structured error responses

### Phase 3: Config
- P3-001: Cron config (if scheduled) -- Add to `supabase/config.toml`
```

### TEMPLATE E: Feature Tier Addition

If the request is for adding features to a pricing tier:

```markdown
## Pre-filled Plan Structure (Feature Tier Addition)

### Phase 1: Database
- P1-001: Migration -- New tables/columns for tier features
- P1-002: Type sync -- Update type aliases

### Phase 2: Backend
- P2-001: Data layer -- Access functions with tier checks
- P2-002: Server actions -- CRUD with tier-based permissions

### Phase 3: UI
- P3-001: Feature pages -- Dashboard pages for new features
- P3-002: Navigation update -- Add to tier-appropriate nav

### Phase 4: Marketing & Docs
- P4-001: Pricing update -- `website/src/data/pricing.ts`
- P4-002: Feature comparison -- `FeatureComparison.tsx`
- P4-003: FAQ update -- `PricingFAQ.tsx`
- P4-004: Documentation -- Feature docs pages
```

### If No Template Matches

Proceed directly to PHASE 1 (Feature Understanding) as normal. Not every request fits a template.

---

## PHASE 1: FEATURE UNDERSTANDING

### 1.1 Capture Requirements

```markdown
## Feature Request Analysis

### User Request
[Exact user request]

### Feature Type
[ ] New Feature (creating something new)
[ ] Enhancement (improving existing)
[ ] Bug Fix (correcting behavior)
[ ] Refactor (restructuring code)

### Affected Areas
[ ] MCP Tools (new or modified tools)
[ ] Hooks (new or modified hooks)
[ ] Config (new config sections)
[ ] Database (SQLite schema changes)
[ ] Core Library (shared utilities)
[ ] Tests (new or modified tests)
[ ] Website (Next.js pages, components, API routes)
[ ] Supabase (migrations, edge functions, RLS policies)
```

### 1.2 Identify Similar Features

```bash
# Search for similar features in codebase
grep -rn "[feature_keyword]" packages/core/src/ --include="*.ts" | head -20

# Find similar tool modules
ls -la packages/core/src/*-tools.ts

# Find similar tests
ls -la packages/core/src/__tests__/
```

**Document findings:**
```markdown
### Similar Features Found
| Feature | Location | Patterns Used |
|---------|----------|---------------|
| [name] | [path] | [patterns] |
```

---

## PHASE 2: ARCHITECTURE REALITY CHECK

### 2.1 Module Structure Verification

For EACH module the feature might affect:

```bash
# Check if module exists
ls -la packages/core/src/[module].ts

# Check current exports
grep "export function\|export interface\|export type\|export const" packages/core/src/[module].ts

# Check if module is wired into tools.ts
grep "[module]" packages/core/src/tools.ts
```

### 2.2 Tool Registration Check

If adding MCP tools, verify the registration pattern:

```bash
# Check existing tool registration pattern
grep "getToolDefinitions\|handleToolCall\|isTool" packages/core/src/tools.ts | head -20

# Count current tools
grep -c "name:" packages/core/src/tools.ts
```

### 2.3 Config Schema Check

If adding config sections, verify config.ts interface:

```bash
# Check current Config interface
grep -A 5 "export interface Config" packages/core/src/config.ts

# Check what config sections exist
grep "^\w\+:" massu.config.yaml | head -20
```

### 2.4 Test Coverage Check

```bash
# Check existing tests for affected module
ls -la packages/core/src/__tests__/[module]*.test.ts

# Count test files
ls packages/core/src/__tests__/*.test.ts | wc -l
```

### 2.5 Document Architecture Reality

```markdown
### Architecture Reality

#### Existing Modules to Modify
| Module | Exists | Current Purpose | Test Coverage |
|--------|--------|-----------------|---------------|
| [path] | YES/NO | [what it does] | [test file] |

#### New Modules to Create
| Module | Purpose | Pattern Reference |
|--------|---------|-------------------|
| [path] | [why] | [similar module] |

#### Tool Registration Required
| Tool Name | Definition | Handler | Test |
|-----------|------------|---------|------|
| [name] | [module]-tools.ts | [module]-tools.ts | __tests__/[module].test.ts |
```

---

## PHASE 3: CODEBASE REALITY CHECK

### 3.1 Verify File Structure

```bash
# Check if target directories exist
ls -la packages/core/src/

# Check if files to modify exist
ls -la [file_path]
```

### 3.2 Read Existing Patterns

```bash
# Always read CLAUDE.md
cat .claude/CLAUDE.md

# Read similar module for patterns
cat packages/core/src/[similar-module].ts | head -80
```

### 3.3 Document Codebase Reality

```markdown
### Codebase Reality

#### Existing Files to Modify
| File | Exists | Current Purpose |
|------|--------|-----------------|
| [path] | YES/NO | [what it does] |

#### New Files to Create
| File | Purpose | Pattern Reference |
|------|---------|-------------------|
| [path] | [why] | [similar module] |

#### Required Changes to tools.ts
| Change | Location | What |
|--------|----------|------|
| Import | top | import { get/is/handle } from './[module].ts' |
| Definition | getToolDefinitions() | ...getXToolDefinitions() |
| Handler | handleToolCall() | if (isXTool(name)) return handleXToolCall(...) |
```

---

## PHASE 3.5: BLAST RADIUS ANALYSIS (MANDATORY for value changes)

**MANDATORY**: When ANY plan changes a constant value, export name, config key, tool name, or file path, you MUST identify ALL occurrences across the ENTIRE codebase.

### Blast Radius Analysis Protocol

#### Step 1: Identify ALL Changed Values

```markdown
### Changed Values Inventory

| # | Old Value | New Value | Type | Scope |
|---|-----------|-----------|------|-------|
| 1 | [old] | [new] | export name | codebase-wide |
```

#### Step 2: Codebase-Wide Grep for EACH Changed Value

```bash
# For EACH old value:
grep -rn '[old_value]' packages/ --include="*.ts" | grep -v node_modules
grep -rn '[old_value]' massu.config.yaml
```

#### Step 3: Categorize EVERY Occurrence

```markdown
### Blast Radius: [old] -> [new]

**Total occurrences found: [N]**

| # | File | Line | Context | Action | Reason |
|---|------|------|---------|--------|--------|
| 1 | [file] | [line] | [context] | CHANGE/KEEP | [reason] |

### Blast Radius Completeness
- Total occurrences: [N]
- Categorized: [N] (MUST be 100%)
- Uncategorized: 0 (MUST be 0)
```

---

## PHASE 4: MASSU PATTERN COMPLIANCE

### 4.1 Mandatory Pattern Review

```markdown
### Pattern Compliance Checklist

#### Module Patterns
- [ ] ESM imports (no require())
- [ ] Config via getConfig() (no direct YAML parse)
- [ ] No process.exit() in library code
- [ ] No module.exports

#### Tool Registration Patterns (if adding tools)
- [ ] getXToolDefinitions() function
- [ ] isXTool() function
- [ ] handleXToolCall() function
- [ ] All 3 wired into tools.ts
- [ ] Tool names use configurable prefix via p()

#### Hook Patterns (if adding hooks)
- [ ] JSON stdin/stdout
- [ ] No heavy dependencies
- [ ] Compiles with esbuild
- [ ] Exits within 5 seconds

#### Testing Patterns
- [ ] Test file in __tests__/ directory
- [ ] Named [module].test.ts
- [ ] Tests cover tool definitions + handlers

#### Config Patterns (if adding config)
- [ ] Interface added to Config in config.ts
- [ ] Default values documented
- [ ] Example in massu.config.yaml
```

### 4.2 Similar Feature Analysis

Read the most similar module and its tests. Document: input validation approach, tool registration pattern, error handling, config access, test structure.

---

## PHASE 4.5: BACKEND-FRONTEND COUPLING CHECK

**MANDATORY**: If the plan includes backend/tool changes, it MUST include corresponding integration or test changes.

| Backend Change | Required Corresponding Change |
|----------------|-------------------------------|
| New tool definitions | Wire into tools.ts + test coverage |
| New config fields | Config interface update + YAML example |
| Changed type structure | All consumers updated |
| New exports | Import added where needed |

Before finalizing: for EVERY new tool, type, or procedure added, verify there is a corresponding registration and test item. If NO, ADD IT NOW.

---

## PHASE 4.7: QUESTION FILTERING (Before Writing Plan)

After all research phases, list every open question about the feature. Then self-filter:

1. **List all questions** you have about requirements, behavior, edge cases, or architecture
2. **For each question, ask**: "Can I answer this by reading more code or checking config?"
3. **Self-answer** every question you can by reading the relevant files
4. **Surface only the remaining questions** to the user via AskUserQuestion

Questions that should be self-answered (do NOT ask the user):
- "What does this module look like?" - read the file
- "How does the existing feature handle X?" - read the module/test
- "What pattern should I follow?" - read CLAUDE.md
- "Does this config key exist?" - check massu.config.yaml

Questions that require the user:
- Business logic decisions ("Should this tool be synchronous or async?")
- Scope decisions ("Should this include CLI output formatting?")
- Priority trade-offs ("Full implementation or v1 subset?")
- Design preferences ("Separate module or extend existing?")

**If all questions are self-answerable, skip the user prompt entirely and proceed to plan generation.**

Update coverage map: mark D9 (Edge Cases) as `done`.

---

## PHASE 4.8: SECURITY PRE-SCREEN (Shift-Left Gate)

Score the plan against these 6 security dimensions:

| # | Dimension | Check |
|---|-----------|-------|
| S1 | Input validation | All external inputs have Zod/validation |
| S2 | Auth boundaries | Protected operations require auth |
| S3 | Data exposure | No sensitive data in logs/responses |
| S4 | Secret handling | No hardcoded secrets (CR-5) |
| S5 | Injection risk | No raw string interpolation in queries |
| S6 | Error leakage | Error messages don't expose internals |

**Score**: Each dimension = PASS / WARN / BLOCK.
**Gate**: 0 BLOCKS = proceed. Any BLOCK = resolve before Phase 5.

### Skip Condition

Pure read-only cosmetic changes with NO data access changes may skip this phase. Document: `Phase 4.8 SKIPPED: [reason -- cosmetic-only, no data flow changes]`.

Update coverage map: mark D6, D7, D8, D10 as `done`.

---

## PHASE 5: PLAN GENERATION

### 5.1 Plan Structure

```markdown
# Implementation Plan: [Feature Name]

## Overview
- **Feature**: [one-line description]
- **Complexity**: Low / Medium / High
- **Areas**: [MCP Tools, Hooks, Config, Database, Core, Tests]
- **Estimated Items**: [count]

## Feasibility Status
- File structure verified: YES
- Patterns reviewed: YES
- Similar features analyzed: YES

## Requirements Coverage
| Dimension | Status | Resolution |
|-----------|--------|------------|
| D1 Problem & Scope | done | User request + interview |
| D2 Users & Personas | done | [how resolved] |
| D3 Architecture | done | Phase 2 architecture check |
| D4 Module Design | done | Phase 3 codebase check |
| D5 UX / API Surface | done | [how resolved] |
| D6 Auth & Permissions | done | Phase 4 pattern compliance |
| D7 Error Handling | done | Phase 4 pattern compliance |
| D8 Security | done | Phase 4.8 pre-screen |
| D9 Edge Cases | done | Phase 4.7 question filtering |
| D10 Performance | done | Phase 4 pattern compliance |
**Coverage Gate**: X/10 dimensions resolved (deferred: Y)

---

## Phase 1: Core Implementation

### P1-001: [Module Name]
- **Type**: MODULE_CREATE / MODULE_MODIFY
- **File**: packages/core/src/[module].ts
- **Action**: CREATE / MODIFY
- **Exports**:
  - `getXToolDefinitions()`
  - `isXTool()`
  - `handleXToolCall()`
- **Pattern References**:
  - [ ] ESM imports
  - [ ] getConfig() for config access
  - [ ] Tool prefix via p()
- **Verification**: VR-FILE + VR-GREP

### P1-002: [Tool Registration]
- **Type**: TOOL_WIRE
- **File**: packages/core/src/tools.ts
- **Action**: MODIFY
- **Changes**:
  - Add import for new module
  - Add definitions to getToolDefinitions()
  - Add handler routing to handleToolCall()
- **Verification**: VR-TOOL-REG

---

## Phase 2: Tests

### P2-001: [Test Module]
- **Type**: TEST
- **File**: packages/core/src/__tests__/[module].test.ts
- **Action**: CREATE
- **Covers**: Tool definitions, handlers, edge cases
- **Verification**: VR-TEST (npm test)

---

## Phase 3: Config & Documentation (if applicable)

### P3-001: [Config Update]
- **Type**: CONFIG
- **File**: packages/core/src/config.ts + massu.config.yaml
- **Action**: MODIFY
- **Changes**: Add interface fields + example config
- **Verification**: VR-CONFIG

---

## Verification Commands

| Item | Type | Verification Command |
|------|------|---------------------|
| P1-001 | MODULE | `ls -la packages/core/src/[module].ts` |
| P1-002 | TOOL_WIRE | `grep "getXToolDefinitions" packages/core/src/tools.ts` |
| P2-001 | TEST | `npm test` |
| P3-001 | CONFIG | Parse config without error |

---

## Item Summary

| Phase | Items | Description |
|-------|-------|-------------|
| Phase 1 | N | Core implementation |
| Phase 2 | N | Tests |
| Phase 3 | N | Config & documentation |
| **Total** | **N** | All deliverables |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| [risk] | Low/Med/High | Low/Med/High | [how to handle] |

---

## Dependencies

| Item | Depends On | Reason |
|------|------------|--------|
| P1-002 | P1-001 | Needs module to exist |
| P2-001 | P1-001 | Needs module to test |
```

### 5.2 Item Numbering Convention

| Phase | Prefix | Example |
|-------|--------|---------|
| Core Implementation | P1-XXX | P1-001, P1-002 |
| Tests | P2-XXX | P2-001, P2-002 |
| Config & Docs | P3-XXX | P3-001, P3-002 |

**Every item MUST have a unique ID for tracking.**

---

## PHASE 6: FEASIBILITY VALIDATION

### 6.1 Pre-Flight Check

```markdown
### Feasibility Validation

#### Code Feasibility
| Check | Command | Result | Status |
|-------|---------|--------|--------|
| Similar module exists | grep/ls | Found | PASS/FAIL |
| Pattern scanner | massu-pattern-scanner.sh | Exit 0 | PASS/FAIL |
| Tools.ts writable | ls -la tools.ts | Exists | PASS/FAIL |

#### Config Feasibility
| Check | Command | Result | Status |
|-------|---------|--------|--------|
| Config parses | `node -e "require('yaml').parse(require('fs').readFileSync('massu.config.yaml','utf-8'))"` | No errors | PASS/FAIL |
| Required keys present | `grep -c 'toolPrefix\|paths\|framework' massu.config.yaml` | >= 3 | PASS/FAIL |

#### Build Feasibility
| Check | Command | Result | Status |
|-------|---------|--------|--------|
| TypeScript compiles | cd packages/core && npx tsc --noEmit | 0 errors | PASS/FAIL |
| Tests pass | npm test | All pass | PASS/FAIL |
| Hooks compile | cd packages/core && npm run build:hooks | Exit 0 | PASS/FAIL |

**FEASIBILITY GATE: PASS / FAIL**
```

### 6.2 Implementation Specificity Check (MANDATORY)

**Every plan item MUST have implementation details specific enough to execute WITHOUT guessing.**

| Requirement | Check |
|-------------|-------|
| **Exact file path** | Not "add a module" but `packages/core/src/foo.ts` |
| **Exact exports** | Not "export functions" but `getFooToolDefinitions, isFooTool, handleFooToolCall` |
| **Pattern reference** | Which existing module to follow |
| **Verification command** | Specific grep/ls that proves the item was implemented |

Specificity by type: MODULE (path + exports + pattern), TOOL_WIRE (tools.ts changes: import + definition + handler), TEST (file path + covers + assertions), CONFIG (interface changes + YAML example), HOOK (file path + stdin/stdout format + esbuild compat).

If ANY item lacks specificity: research the target format, write the exact implementation, then update the plan.

### 6.3 If Feasibility Fails

1. Identify blockers
2. Add prerequisites
3. Revise plan
4. Re-validate

---

## OUTPUT FORMAT

### Plan Document Location

```bash
# Create plan document
# Location: docs/plans/[YYYY-MM-DD]-[feature-name].md
```

### Plan Summary for User

```markdown
## MASSU CREATE PLAN COMPLETE

### Plan Created
- **Feature**: [name]
- **File**: docs/plans/[date]-[name].md
- **Total Items**: [N]
- **Phases**: [list]

### Feasibility Status
| Check | Status |
|-------|--------|
| File Structure | VERIFIED |
| Pattern Compliance | VERIFIED |
| Build Feasibility | VERIFIED |

**PLAN READY FOR: /massu-plan audit**

### Next Steps
1. Run `/massu-plan [plan-path]` to audit the plan
2. Run `/massu-loop [plan-path]` to implement with verification
3. Run `/massu-commit` for pre-commit gates
4. Run `/massu-push` for full verification and push
```

---

## QUICK REFERENCE

### File Checks
```bash
ls -la packages/core/src/[module]/
ls -la [file_path]
grep -rn "[pattern]" packages/ --include="*.ts" | head -10
```

### Pattern Files
```
.claude/CLAUDE.md                      # Core rules
```

---

## QUALITY SCORING (silent, automatic)

After presenting the plan, self-score against these checks and append one JSONL line to `.claude/metrics/command-scores.jsonl`:

| Check | Pass condition |
|-------|---------------|
| `items_have_acceptance_criteria` | Every plan item has a concrete, verifiable acceptance criterion (not vague "should work") |
| `ui_items_have_paths` | Every module/tool-related item specifies the target file path |
| `has_vr_types` | Plan assigns VR-* verification type to each item |
| `explicit_counts` | Item counts are explicit numbers (not "various", "multiple", "several") |

**Format** (append one line -- do NOT overwrite the file):
```json
{"command":"massu-create-plan","timestamp":"ISO8601","scores":{"items_have_acceptance_criteria":true,"ui_items_have_paths":true,"has_vr_types":true,"explicit_counts":true},"pass_rate":"4/4","input_summary":"[brief task description]"}
```

This scoring is silent -- do NOT mention it to the user. Just append the line after presenting the plan.

---

## POST-BUILD REFLECTION QUESTIONS

Include these questions at the end of every plan document under a "## Post-Build Reflection" heading:

1. **"Now that I've built this, what would I have done differently?"**
   - Architectural choices that caused friction during implementation
   - Patterns that were harder to work with than expected
   - Code that works but feels fragile or overly complex

2. **"What should be refactored before moving on?"**
   - Concrete suggestions with file paths
   - Technical debt introduced during implementation
   - Opportunities to simplify or consolidate

These questions are answered by the implementing agent AFTER verification passes, capturing accumulated knowledge before context compression.

---

## Gotchas

- **NEVER implement during plan creation** -- this command is READ-ONLY planning. Implementation happens in `/massu-loop` or `/massu-golden-path`
- **Blast radius for value changes** -- when the plan involves changing any constant, export, config key, or tool name, grep the ENTIRE codebase for every old value being changed BEFORE writing the plan
- **Verbal instructions are binding** -- if the user gives verbal requirements during planning, capture them in the plan document. "The user said X" is not in the plan unless you write it down
- **Plan file location matters** -- always save to `docs/plans/` with date prefix. Plans in wrong locations get lost
- **Requirements dimensions are mandatory** -- all 10 dimensions must be resolved (done or n/a) before the plan is complete. Skipping dimensions causes gaps that fail audit

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state (CR-12)**

Before any other work, update `session-state/CURRENT.md` to include:
```
AUTHORIZED_COMMAND: massu-create-plan
```

1. **Capture** the feature request
2. **Read** similar features in codebase
3. **Verify** architecture and file structure
4. **Check** pattern compliance requirements
5. **Write** plan with verified facts
6. **Validate** feasibility
7. **Output** plan document
8. **Score and append to command-scores.jsonl** (silent)

**Remember: Read first, plan second. No assumptions, only evidence.**
