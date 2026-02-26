---
name: massu-guide
description: Interactive onboarding walkthrough for the Massu codebase and .claude/ infrastructure
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---
name: massu-guide

# Massu Guide: Codebase Onboarding Walkthrough

## Objective

Provide a guided orientation for new developers (or fresh AI sessions) to understand Massu -- its architecture, .claude/ infrastructure, workflows, and common gotchas. Read-only exploration, no modifications.

---

## WALKTHROUGH (5 Sections)

### Section 1: Project Overview

Read and present:

```bash
# Tech stack from package.json
cat packages/core/package.json | jq '{name, version, scripts: (.scripts | keys | length), dependencies: (.dependencies | keys | length), devDependencies: (.devDependencies | keys | length)}'
```

Read `.claude/CLAUDE.md` first 30 lines -- Project Overview and Architecture.

Count key entities:
```bash
ls packages/core/src/*.ts 2>/dev/null | wc -l           # Source modules
ls packages/core/src/__tests__/*.test.ts 2>/dev/null | wc -l  # Tests
ls packages/core/src/hooks/*.ts 2>/dev/null | wc -l      # Hooks
```

Output: "Massu: TypeScript MCP Server + Claude Code Plugin with N source modules, N tests, N hooks."

---

### Section 2: Architecture Map

Count manually:
```bash
echo "=== ARCHITECTURE MAP ==="
echo "Source modules: $(ls packages/core/src/*.ts 2>/dev/null | wc -l)"
echo "Test files:     $(ls packages/core/src/__tests__/*.test.ts 2>/dev/null | wc -l)"
echo "Hook files:     $(ls packages/core/src/hooks/*.ts 2>/dev/null | wc -l)"
echo "Scripts:        $(ls scripts/*.sh 2>/dev/null | wc -l)"
echo "Commands:       $(ls .claude/commands/*.md 2>/dev/null | wc -l)"
```

Highlight key files:
- `packages/core/src/tools.ts` -- Tool definitions & routing (central hub)
- `packages/core/src/config.ts` -- Config loader (massu.config.yaml)
- `packages/core/src/server.ts` -- MCP server entry point
- `packages/core/src/db.ts` -- Database connections (CodeGraph + Data)
- `packages/core/src/memory-db.ts` -- Memory database (session, analytics, audit)
- `massu.config.yaml` -- Single source of project-specific data

---

### Section 3: Infrastructure Tour

```bash
echo "=== .CLAUDE/ INFRASTRUCTURE ==="
echo "Commands:   $(ls .claude/commands/*.md 2>/dev/null | wc -l)"
echo "CR Rules:   $(grep -c '^| CR-' .claude/CLAUDE.md 2>/dev/null)"
echo "VR Types:   $(grep -c '^| VR-' .claude/CLAUDE.md 2>/dev/null)"
echo "Scripts:    $(ls scripts/*.sh 2>/dev/null | wc -l)"
```

List top 10 most-used commands:
- `/massu-loop` -- Main implementation loop with verification
- `/massu-create-plan` -- Plan generation from requirements
- `/massu-plan` -- Plan audit and improvement
- `/massu-commit` -- Pre-commit verification gate
- `/massu-push` -- Pre-push full verification
- `/massu-verify` -- Run all VR-* checks
- `/massu-test` -- Test coverage audit
- `/massu-tdd` -- Test-driven development cycle
- `/massu-hotfix` -- Emergency fix protocol
- `/massu-debug` -- Systematic debugging

---

### Section 4: Key Workflows

Present the standard development workflow:

```
/massu-create-plan -> /massu-plan -> /massu-loop -> /massu-commit -> /massu-push
(CREATE)            (AUDIT)        (IMPLEMENT)   (COMMIT)        (PUSH)
```

Explain the verification system:
- **VR-BUILD**: `npm run build` must exit 0
- **VR-TYPE**: `cd packages/core && npx tsc --noEmit` must have 0 errors
- **VR-TEST**: `npm test` must pass (MANDATORY)
- **VR-PATTERN**: `bash scripts/massu-pattern-scanner.sh` must exit 0
- **VR-NEGATIVE**: grep returns 0 matches for removed code

Explain the audit commands:
- `/massu-internal-codebase-audit` -- Full quality assessment
- `/massu-internal-security-scan` -- Security-focused audit
- `/massu-internal-db-audit` -- Database schema audit
- `/massu-dead-code` -- Unused code detection

---

### Section 5: Common Gotchas

Extract from CLAUDE.md:

**Config Rules**:
- Use `getConfig()` NOT direct YAML parsing
- Use `massu.config.yaml` for ALL project-specific data
- Tool prefix is configurable (`massu_` default)

**Build Rules**:
- ESM imports require `.ts` extension: `import { x } from './y.ts'`
- Hooks MUST compile with esbuild: `cd packages/core && npm run build:hooks`
- All 3 databases have different access patterns (CodeGraph=read-only)

**Tool Registration Rules**:
- Every new tool MUST be wired in `tools.ts` (CR-11)
- Preferred: 3-function pattern (getDefs + isTool + handleCall)
- Legacy: 2-function + inline routing

**Database Rules**:
- `getCodeGraphDb()` -- NEVER write to this (read-only)
- `getDataDb()` -- Import edges, tRPC, sentinel
- `getMemoryDb()` -- Session memory (ALWAYS close after use)

**Known Patterns**:

| Pattern | Correct | Error if Wrong |
|---------|---------|----------------|
| ESM imports | `import { x } from './y.ts'` | Pattern scanner fails |
| Config access | `getConfig().toolPrefix` | Direct YAML parse bypasses caching |
| Tool prefix | `p('tool_name')` helper | Hardcoded prefix breaks portability |
| memDb lifecycle | `try { ... } finally { memDb.close(); }` | DB connection leak |

---

## OUTPUT FORMAT

Present each section with a clear header and structured output. After all 5 sections, provide:

```markdown
## ORIENTATION COMPLETE

You are now oriented with:
- [X] Project tech stack and scale
- [X] Architecture map with key files
- [X] .claude/ infrastructure (commands, scripts, rules)
- [X] Standard workflows and verification system
- [X] Common gotchas and patterns

**Ready to start work. Recommended next steps:**
1. Read the plan file if one exists
2. Run `/massu-create-plan` for new features
3. Use `/massu-verify` to check current state
```

---

**This is a read-only command. It explores and presents -- it does not modify any files.**
