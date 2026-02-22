# Massu Development

## Project Overview
AI Engineering Governance Platform - an MCP server and Claude Code plugin.

## Architecture
- Monorepo: `packages/core` (MCP server) + `packages/plugin` (Claude Code plugin)
- Source code in `packages/core/src/` - fully generalized and config-driven
- Config-driven: all project-specific data moves to `massu.config.yaml`

## Key Rules
- All project-specific data must use config lookups (no hardcoding)
- The `massu.config.yaml` is the single source of project-specific data
- Tool prefix is configurable via `massu.config.yaml` (default: `massu_`)
- Domain definitions, coding rules, and known mismatches come from config
- The config schema must be documented with examples

## Current State
- Fully generalized codebase with config-driven architecture
- Config system wired in via `getConfig()` / `massu.config.yaml`
- All project-specific data externalized to config

## Tech Stack
- TypeScript, ESM modules
- better-sqlite3 for local storage
- Raw JSON-RPC 2.0 over stdio (MCP protocol)
- yaml for config parsing
- esbuild for hook compilation
- vitest for testing

---

## Canonical Rules (CR)

| ID | Rule | Verification Type |
|----|------|-------------------|
| CR-1 | Never claim state without proof | VR-* |
| CR-2 | Never assume file/module structure | VR-FILE, VR-GREP |
| CR-3 | Never commit secrets | git status check |
| CR-4 | Verify removals with negative grep | VR-NEGATIVE |
| CR-5 | Read plan file, not memory | Plan file open |
| CR-6 | Check ALL items in plan, not "most" | VR-COUNT |
| CR-7 | ALL tests MUST pass before claiming complete | VR-TEST |
| CR-8 | Protocol commands are mandatory execution instructions | VR-PROTOCOL |
| CR-9 | Fix ALL issues encountered (pre-existing included) | VR-FIX |
| CR-10 | Blast radius analysis for value changes | VR-BLAST-RADIUS |
| CR-11 | New MCP tools MUST be registered in tools.ts | VR-TOOL-REG |
| CR-12 | Hooks MUST compile with esbuild | VR-HOOK-BUILD |
| CR-13 | No stub/TODO auth code in production | VR-GREP |
| CR-14 | All paid features must be server-side gated | VR-GREP |
| CR-15 | Security mechanisms must fail hard | VR-GREP |
| CR-16 | Marketing claims must match source data | VR-TEST |
| CR-17 | API responses must not leak secrets | VR-GREP |

### CR-8: Protocol Commands Are Mandatory Execution Instructions

**ALL slash commands and protocol files are MANDATORY execution instructions, not advisory documentation.**

- When a protocol says "loop until X" - loop until X. Do not stop before X.
- When a protocol says "MUST restart from Step 1" - restart from Step 1.
- When a protocol says "FORBIDDEN" - it is forbidden.
- Default behavior patterns (report findings, ask user, suggest next steps) MUST yield to explicit protocol instructions.

### CR-9: Fix ALL Issues Encountered

**ANY issue discovered during work MUST be fixed immediately, whether from current changes or pre-existing.** "Not in scope" and "pre-existing" are NEVER valid reasons to skip. When fixing a bug, search entire codebase for the same pattern and fix ALL instances.

### CR-10: Blast Radius Analysis for Value Changes

**When ANY plan changes a constant value, export name, config key, or tool name, ALL codebase references MUST be identified and categorized.**

- Grep the ENTIRE codebase for every old value being changed
- Categorize EVERY occurrence as CHANGE, KEEP (with reason), or INVESTIGATE
- Zero INVESTIGATE items allowed before implementation starts
- Every CHANGE item must appear as a plan deliverable

### CR-11: MCP Tool Registration

**Every new MCP tool module MUST be wired into `tools.ts`.**

There are two registration patterns in use:

**Pattern A: 3-function pattern (preferred for new modules)**
Used by: analytics, cost-tracker, prompt-analyzer, audit-trail, validation-engine, adr-generator, security-scorer, dependency-scorer, team-knowledge, regression-detector, observability-tools

1. `getXToolDefinitions()` - Returns tool definitions
2. `isXTool(name)` - Returns boolean for tool name matching
3. `handleXToolCall(name, args, ...)` - Handles tool execution

**Pattern B: 2-function + inline routing (legacy modules)**
Used by: memory-tools, docs-tools, sentinel-tools

1. `getXToolDefinitions()` - Returns tool definitions
2. `handleXToolCall(name, args, ...)` - Handles tool execution
3. Routing via `name.startsWith(pfx + '_prefix_')` inline in tools.ts

**VR-TOOL-REG verification:**
```bash
# Verify tool definitions imported and spread into getToolDefinitions()
grep "getXToolDefinitions\|...getX" packages/core/src/tools.ts
# Verify tool handler is wired in handleToolCall()
grep "handleXToolCall\|isXTool\|startsWith.*'_x_'" packages/core/src/tools.ts
```

### CR-12: Hook Compilation

**All hooks in `packages/core/src/hooks/` MUST compile with esbuild.**

```bash
cd packages/core && npm run build:hooks
# MUST exit 0
```

Hooks receive JSON on stdin, output JSON on stdout, and must exit within 5 seconds. Never import heavy dependencies in hooks.

### CR-13: No Stub Auth Code in Production

**Authentication and authorization code MUST be complete. TODO/stub implementations in auth flows are CRITICAL security violations.**

- `grep -rn 'TODO\|FIXME\|stub\|placeholder' src/ | grep -i auth` must return 0 results
- SSO callbacks must validate tokens/assertions (not pass-through)
- Auth middleware must not have bypass paths outside explicit allowlists

### CR-14: All Paid Features Must Be Server-Side Gated

**Every dashboard page and API route that is tier-restricted MUST enforce `requirePlan()` server-side. Client-side nav hiding is NOT sufficient.**

- Every page under `(dashboard)/` that shows paid features must call `requirePlan()` or equivalent
- API routes returning tier-restricted data must verify plan server-side
- Client-side hiding is supplementary only, never the sole gate

### CR-15: No Silent Security Fallbacks

**Security mechanisms (encryption, auth, validation) MUST fail hard. Silent fallback to weaker security is prohibited.**

- Encryption failure must throw, never fall back to plaintext
- Auth failure must return 401/403, never serve content anyway
- Validation failure must reject input, never accept silently

### CR-16: Marketing Claims Must Match Source Data

**Feature counts, tool counts, and tier claims displayed on the website MUST be derived from source data, not hardcoded. Discrepancies between data and display are HIGH severity.**

- Tool counts on marketing pages must come from config/database
- Tier badges must reflect actual tier from data source
- Pricing must match `massu.config.yaml` values

### CR-17: API Responses Must Not Leak Secrets

**API GET responses MUST explicitly select fields. `select('*')` is prohibited in API routes that return data to clients.**

- Every Supabase query in API GET handlers must use explicit `.select('field1, field2')`
- Fields named `secret`, `key`, `password`, `token` must never appear in GET responses
- Use DTO/projection patterns to control response shape

---

## Verification Requirements (VR)

| Type | Command | Expected | Use When |
|------|---------|----------|----------|
| VR-FILE | `ls -la [path]` | File exists | Claiming file created |
| VR-GREP | `grep "[pattern]" [file]` | Match found | Claiming code added |
| VR-NEGATIVE | `grep -rn "[old]" packages/core/src/` | 0 matches | Claiming removal |
| VR-BUILD | `npm run build` | Exit 0 | Claiming production ready |
| VR-TYPE | `cd packages/core && npx tsc --noEmit` | 0 errors | Claiming type safety |
| VR-TEST | `npm test` | ALL pass (vitest) | ALWAYS before claiming complete |
| VR-COUNT | `grep -c "[pattern]" [file]` | Expected count | Verifying all instances |
| VR-TOOL-REG | grep for definitions + handler in tools.ts | All wired | After adding MCP tools |
| VR-HOOK-BUILD | `cd packages/core && npm run build:hooks` | Exit 0 | After modifying hooks |
| VR-CONFIG | Parse `massu.config.yaml` without errors | Valid YAML | After config changes |
| VR-PATTERN | `bash scripts/massu-pattern-scanner.sh` | Exit 0 | Before every commit |
| VR-PLAN-COVERAGE | Item-by-item verification with proof | 100% items verified | Before claiming plan complete |
| VR-BLAST-RADIUS | Grep codebase for ALL refs to changed value | 0 uncategorized refs | Changing any constant/export/config |
| VR-PROTOCOL | Verify protocol execution matches protocol text | All steps executed | After any slash command |

---

## Massu Development Patterns

### Tool Registration Pattern

When adding a new MCP tool module:

```typescript
// In a new file, e.g., packages/core/src/foo-analyzer.ts
// (naming: descriptive, NOT required to end in -tools.ts)

// 1. Define tool definitions
export function getFooToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: `${getConfig().toolPrefix}_foo_action`,
      description: 'Does the foo action',
      inputSchema: {
        type: 'object',
        properties: { bar: { type: 'string', description: 'The bar param' } },
        required: ['bar'],
      },
    },
  ];
}

// 2. Tool name matching
export function isFooTool(name: string): boolean {
  return name.endsWith('_foo_action');
}

// 3. Tool handler
export function handleFooToolCall(
  name: string,
  args: Record<string, unknown>,
  memDb: Database.Database
): ToolResult {
  const baseName = stripPrefix(name);
  switch (baseName) {
    case 'foo_action':
      return { content: [{ type: 'text', text: 'result' }] };
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
}
```

Then wire into `tools.ts`:
```typescript
import { getFooToolDefinitions, isFooTool, handleFooToolCall } from './foo-analyzer.ts';

// In getToolDefinitions():
...getFooToolDefinitions(),

// In handleToolCall():
if (isFooTool(name)) {
  const memDb = getMemoryDb();
  try { return handleFooToolCall(name, args, memDb); }
  finally { memDb.close(); }
}
```

### Hook stdin/stdout Pattern

Hooks receive JSON on stdin and output JSON on stdout:

```typescript
// packages/core/src/hooks/my-hook.ts
import { readFileSync } from 'fs';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));
const { tool_name, tool_input } = input;

// Process...

// Output result
const output = JSON.stringify({ result: 'ok' });
process.stdout.write(output);
```

### Config Access Pattern

**ALWAYS use `getConfig()` from `config.ts`. NEVER parse YAML directly.**

```typescript
import { getConfig, getProjectRoot } from './config.ts';

const config = getConfig();
const prefix = config.toolPrefix;        // 'massu' (default)
const framework = config.framework.type; // 'typescript'
const srcPath = config.paths.source;     // 'src'
```

### SQLite Database Pattern

Three databases:

| Database | Function | Module | Purpose | Access |
|----------|----------|--------|---------|--------|
| **CodeGraph DB** | `getCodeGraphDb()` | `db.ts` | Vanilla CodeGraph data (files, nodes, edges) | **Read-only** |
| **Data DB** | `getDataDb()` | `db.ts` | Import edges, tRPC mappings, sentinel registry | Read-write |
| **Memory DB** | `getMemoryDb()` | `memory-db.ts` | Session memory, observations, analytics, audit trail | Read-write |

```typescript
// CodeGraph - NEVER write to this
import { getCodeGraphDb, getDataDb } from './db.ts';
const cgDb = getCodeGraphDb();

// Data DB - import edges, tRPC, sentinel
const dataDb = getDataDb();

// Memory DB - used by most tool handlers (analytics, cost, prompt,
// audit, validation, adr, security, dependency, team, regression, observability)
import { getMemoryDb } from './memory-db.ts';
const memDb = getMemoryDb();
// IMPORTANT: Always close memDb after use (try/finally pattern)
```

### Plan Output Directory

Plans go in `docs/plans/`:
```
docs/plans/YYYY-MM-DD-feature-name.md
```

---

## Quick Reference

### Build & Test Commands

| Command | What | Where |
|---------|------|-------|
| `npm test` | Run all vitest tests | Root (delegates to core) |
| `npm run build` | Type check + compile hooks | Root (delegates to core) |
| `cd packages/core && npm run build:hooks` | Compile hooks only with esbuild | packages/core |
| `cd packages/core && npx tsc --noEmit` | Type check only | packages/core |
| `bash scripts/massu-pattern-scanner.sh` | Pattern compliance (8 checks) | Root |

### Tool Module Inventory

**3-function pattern (preferred):** `getDefs()` + `isTool()` + `handleCall()`

| Module File | Tool Prefix | Has Tests |
|-------------|-------------|-----------|
| `analytics.ts` | `_quality_` | YES |
| `cost-tracker.ts` | `_cost_` | YES |
| `prompt-analyzer.ts` | `_prompt_` | YES |
| `audit-trail.ts` | `_audit_` | YES |
| `validation-engine.ts` | `_validation_` | YES |
| `adr-generator.ts` | `_adr_` | YES |
| `security-scorer.ts` | `_security_` | YES |
| `dependency-scorer.ts` | `_dependency_` | YES |
| `team-knowledge.ts` | `_team_` | YES |
| `regression-detector.ts` | `_regression_` | YES |
| `observability-tools.ts` | `_obs_` | YES |

**2-function pattern (legacy):** `getDefs()` + `handleCall()` (routing inline in tools.ts)

| Module File | Routing | Has Tests |
|-------------|---------|-----------|
| `memory-tools.ts` | `startsWith(pfx + '_memory_')` | YES |
| `docs-tools.ts` | `startsWith(pfx + '_docs_')` | YES |
| `sentinel-tools.ts` | `startsWith(pfx + '_sentinel_')` | YES (partial) |

**Core tools** (inline in `tools.ts`): sync, context, trpc_map, coupling_check, impact, domains, schema

### Common Patterns & Errors

| Pattern | Correct | Error if Wrong |
|---------|---------|----------------|
| ESM imports | `import { x } from './y.ts'` | Pattern scanner fails |
| Config access | `getConfig().toolPrefix` | Direct YAML parse bypasses caching |
| Tool registration | Wire into tools.ts | Tool exists but not callable |
| Hook I/O | JSON stdin/stdout | Hook fails silently |
| DB access | `getCodeGraphDb()` / `getDataDb()` / `getMemoryDb()` | Wrong DB or missing schema |
| Tool prefix | `p('tool_name')` helper | Hardcoded prefix won't work for other projects |
| memDb lifecycle | `try { ... } finally { memDb.close(); }` | DB connection leak |

### File Locations

| Purpose | Path |
|---------|------|
| MCP Server entry | `packages/core/src/server.ts` |
| Tool definitions & routing | `packages/core/src/tools.ts` |
| Config loader | `packages/core/src/config.ts` |
| Database connections (CodeGraph + Data) | `packages/core/src/db.ts` |
| Memory database | `packages/core/src/memory-db.ts` |
| Hook sources | `packages/core/src/hooks/*.ts` |
| Compiled hooks | `packages/core/dist/hooks/*.js` |
| Tests | `packages/core/src/__tests__/*.test.ts` |
| Config file | `massu.config.yaml` |
| Plans | `docs/plans/*.md` |

---

## Session State Maintenance

**Location**: `.claude/session-state/CURRENT.md`

### Update After
- Significant decision (WHAT + WHY)
- Failed attempt (CRITICAL - don't retry)
- File modified
- Task pivot or blocker encountered

---

## Zero Tolerance

| Violation | Consequence |
|-----------|-------------|
| Exposed credentials/secrets | Session termination |
| Unverified "complete" claims | Incident logged, trust damaged |
| Type errors in production | Block deployment |
| Build failures | Block deployment |
| Plan coverage < 100% marked complete | Must continue |
| Stopping massu-loop early | Invalid termination, must resume |
| Claiming complete with failing tests | Must fix tests |
| Protocol command not followed exactly | Must re-execute from start |
| New tool not registered in tools.ts | Feature is invisible |

---

## Workflow Commands

### Implementation Flow
| Command | Purpose | Edits Source Code? |
|---------|---------|-------------------|
| `/massu-plan` | Audit/improve plan document | **NO** (plan doc only) |
| `/massu-create-plan` | Create a viable implementation plan from scratch | **NO** (plan doc only) |
| `/massu-loop` | Implement plan with verification | **YES** |
| `/massu-commit` | Pre-commit verification gate | Fixes only |
| `/massu-push` | Pre-push full verification gate | Fixes only |
| `/massu-push-light` | Fast pre-push verification (~90s) | Fixes only |

**Flow**: plan (audit) -> loop (implement) -> commit -> push

### Development & Quality
| Command | Purpose | Edits Source Code? |
|---------|---------|-------------------|
| `/massu-test` | Intelligent test runner | **YES** (test generation/fix) |
| `/massu-debug` | Systematic debugging | **YES** (applies fixes) |
| `/massu-refactor` | Safe refactoring | **YES** |
| `/massu-release` | Release preparation | **YES** (version bump, tag) |
| `/massu-new-feature` | Pattern-compliant feature scaffolding | **YES** (scaffolding) |
| `/massu-new-pattern` | Create and save new patterns with approval workflow | **YES** |
| `/massu-rebuild` | Safe rebuild/replacement with feature parity enforcement | **YES** |
| `/massu-migrate` | Database migration creation, validation, and rollback generation | **YES** (migrations) |
| `/massu-rollback` | Safe rollback protocol with state preservation | **YES** |

### Code Review & Audits
| Command | Purpose | Edits Source Code? |
|---------|---------|-------------------|
| `/massu-review` | Automated code review across 7 dimensions | **NO** |
| `/massu-codebase-audit` | Comprehensive multi-phase codebase audit | **NO** |
| `/massu-api-contract` | MCP tool contract audit with handler-schema verification | **NO** |
| `/massu-config-audit` | Config validation and config-code alignment check | **NO** |
| `/massu-import-audit` | Import chain audit for heavy/circular deps and ESM violations | **NO** |
| `/massu-type-audit` | Type mismatch audit across module boundaries | **NO** |
| `/massu-learning-audit` | Validate auto-learning effectiveness and memory coverage | **NO** |
| `/massu-feature-parity` | Feature parity check between source systems | **NO** |
| `/massu-gap-analyzer` | Analyze plan implementation for gaps (post-massu-loop) | **NO** |
| `/massu-checkpoint` | Checkpoint audit for current phase with full verification | **NO** |
| `/massu-verify` | Run all VR-* verification checks with mandatory proof | **NO** |

### Security & Compliance
| Command | Purpose | Edits Source Code? |
|---------|---------|-------------------|
| `/massu-security-scan` | Deep security audit (OWASP, API auth, RLS, secrets) | **NO** |
| `/massu-accessibility` | WCAG 2.1 AA accessibility audit | **NO** |
| `/massu-pre-launch` | Comprehensive pre-launch/pre-deploy verification | **NO** |
| `/massu-website-check` | Website-specific verification (TS, Next.js, Supabase) | **NO** |

### Diagnostics & Utilities
| Command | Purpose | Edits Source Code? |
|---------|---------|-------------------|
| `/massu-audit-deps` | Dependency audit (vulns, licenses, unused) | **NO** |
| `/massu-changelog` | Generate changelog from commits | CHANGELOG.md only |
| `/massu-hotfix` | Quick scoped fix workflow | **YES** (small fixes) |
| `/massu-incident` | Automated incident post-mortem with prevention pipeline | **NO** |
| `/massu-status` | Read-only project health dashboard with 14 health checks | **NO** |
| `/massu-sync-public` | Run quality gates, then sync public files to public repo | **NO** |

### Productivity
| Command | Purpose | Edits Source Code? |
|---------|---------|-------------------|
| `/massu-cleanup` | Dead code removal, unused imports, orphaned files | **YES** |
| `/massu-doc-gen` | Generate JSDoc, README, API docs | **YES** (docs only) |
| `/massu-onboard` | Generate onboarding guide for new team members | **NO** |
| `/massu-session-optimization` | Audit and optimize session context overhead | **YES** (optional) |

### Insights
| Command | Purpose | Edits Source Code? |
|---------|---------|-------------------|
| `/massu-retrospective` | Session/sprint retrospective with learnings | **NO** |
| `/massu-benchmark` | Performance benchmarking with baselines | **NO** |
| `/massu-estimate` | Effort estimation with complexity scoring | **NO** |
| `/massu-perf` | Performance analysis (bundle, queries, edge functions) | **NO** |

---

## Core Principles

1. **NO SHORTCUTS** - Quality over speed, always
2. **COMPLETE VERIFICATION** - Proof, not claims
3. **ZERO ASSUMPTIONS** - Check, don't guess
4. **ALL ITEMS** - "Most of them" is not "all of them"
5. **NEGATIVE VERIFICATION** - Removals need grep returning 0
6. **PATTERN COMPLIANCE** - Run `massu-pattern-scanner.sh` before commit
7. **FIX EVERYTHING ENCOUNTERED** - Every issue found MUST be fixed immediately
8. **PROTOCOLS ARE MANDATORY** - Slash commands are execution instructions

---

**Document Status**: v3.3 | **Updated**: Feb 21, 2026
