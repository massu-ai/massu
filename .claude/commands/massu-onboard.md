---
name: massu-onboard
description: Generate a comprehensive onboarding guide for new team members from live codebase analysis
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# CS Onboard: New Team Member Onboarding Guide

## Objective

Analyze the live codebase and generate a comprehensive, accurate onboarding guide for new team members. Covers architecture, setup, key patterns, pitfalls, and day-one tasks. This is READ-ONLY — no files are modified.

**Usage**: `/massu-onboard` (full guide) or `/massu-onboard [role]` (focused: frontend, backend, devops, fullstack)

---

## NON-NEGOTIABLE RULES

- Do NOT modify any files
- All facts MUST come from actual code — never invent examples
- Read source files before describing patterns; never describe from memory
- FIX ALL ISSUES ENCOUNTERED (CR-9) — if the guide would document a broken pattern, flag it
- Output a complete, immediately-useful guide (not a skeleton)

---

## STEP 1: ARCHITECTURE SCAN

Read and summarize the actual project structure.

### 1a. Top-Level Structure

```bash
ls -la /Users/eko3/massu/
ls -la packages/
ls -la packages/core/src/ 2>/dev/null | head -40
ls -la website/src/ 2>/dev/null | head -20
```

### 1b. Entry Points

```bash
# MCP server entry
head -30 packages/core/src/server.ts 2>/dev/null

# Tool registration
head -50 packages/core/src/tools.ts 2>/dev/null

# Website entry
cat website/src/app/layout.tsx 2>/dev/null | head -30
```

### 1c. Package Configuration

```bash
cat package.json 2>/dev/null | grep -A 20 '"scripts"'
cat packages/core/package.json 2>/dev/null | grep -A 10 '"scripts"'
cat website/package.json 2>/dev/null | grep -A 10 '"scripts"' 2>/dev/null
```

### 1d. Config File

```bash
cat massu.config.yaml 2>/dev/null
```

---

## STEP 2: PATTERN EXTRACTION

Read key source files to extract the real patterns, not assumed ones.

### 2a. Tool Registration Pattern

```bash
# Read a representative tool module (3-function pattern)
cat packages/core/src/observability-tools.ts 2>/dev/null | head -60

# Read how tools.ts wires them in
grep -A 5 "getObservability\|isObservability\|handleObservability" packages/core/src/tools.ts 2>/dev/null
```

### 2b. Config Access Pattern

```bash
grep -n "getConfig()" packages/core/src/*.ts | head -15
cat packages/core/src/config.ts 2>/dev/null | head -50
```

### 2c. Database Usage Pattern

```bash
grep -n "getMemoryDb\|getCodeGraphDb\|getDataDb" packages/core/src/*.ts | grep -v "__tests__" | head -20
```

### 2d. Hook Pattern

```bash
ls packages/core/src/hooks/ 2>/dev/null
head -30 packages/core/src/hooks/*.ts 2>/dev/null | head -50
```

### 2e. Test Pattern

```bash
ls packages/core/src/__tests__/ 2>/dev/null
head -40 packages/core/src/__tests__/observability-tools.test.ts 2>/dev/null
```

---

## STEP 3: PITFALL ANALYSIS

Identify common mistakes new developers make in this codebase.

### 3a. Pattern Scanner Violations (most common mistakes)

```bash
bash scripts/massu-pattern-scanner.sh 2>&1 | head -30
```

Extract what the scanner checks — these become the "DO NOT DO" list.

### 3b. Common Type Errors

```bash
cd packages/core && npx tsc --noEmit 2>&1 | head -20
```

### 3c. Tool Registration Pitfalls

```bash
# Is there any tool module NOT wired into tools.ts? (example of the mistake)
grep -l "getToolDefinitions\(\)" packages/core/src/*.ts | grep -v "tools.ts"
```

### 3d. Config Access Anti-Patterns

```bash
# Anyone bypassing getConfig()?
grep -rn "yaml.parse\|readFileSync.*config" packages/core/src/ --include="*.ts" | grep -v "__tests__"
```

---

## STEP 4: GUIDE GENERATION

Generate the complete onboarding document. Output it directly (do NOT write to a file unless explicitly asked).

---

## OUTPUT FORMAT

```markdown
# Massu Onboarding Guide

**Generated**: [date]
**Role Focus**: [role from $ARGUMENTS or "All Roles"]
**Codebase Version**: [git rev-parse --short HEAD]

---

## 1. What Is This Project?

[1-2 paragraph description derived from CLAUDE.md and actual code]

---

## 2. Architecture Overview

### Repository Structure

\`\`\`
massu/
├── packages/
│   ├── core/           # MCP server — [description from actual code]
│   └── plugin/         # Claude Code plugin — [description]
├── website/            # [if exists] Next.js web application
├── scripts/            # Automation and verification scripts
├── massu.config.yaml   # Single source of project-specific data
└── .claude/            # Claude commands and session state
\`\`\`

### How It Works

[2-3 sentence description of the data flow, derived from server.ts and tools.ts]

---

## 3. Local Setup

\`\`\`bash
# 1. Clone and install
git clone [repo]
npm install

# 2. Configure (required before first run)
cp massu.config.yaml.example massu.config.yaml  # if example exists
# Edit massu.config.yaml — see Section 6

# 3. Build
npm run build

# 4. Run tests (must all pass)
npm test
\`\`\`

---

## 4. Daily Development Commands

| Command | What It Does | When To Use |
|---------|-------------|-------------|
| `npm test` | Run all [N] tests | After every change |
| `npm run build` | Type check + compile hooks | Before committing |
| `bash scripts/massu-pattern-scanner.sh` | Check code patterns | Before committing |
| `cd packages/core && npx tsc --noEmit` | TypeScript check only | Quick type check |
| `/massu-status` | Project health dashboard | Orientation, debugging |

---

## 5. Key Patterns (from actual code)

### Adding a New MCP Tool

[Derived from reading an existing tool module — show real code excerpt]

**Step 1: Create the module** (`packages/core/src/your-tool.ts`):
\`\`\`typescript
// [actual pattern from observability-tools.ts or similar]
\`\`\`

**Step 2: Register in tools.ts**:
\`\`\`typescript
// [actual import + spread + handler pattern from tools.ts]
\`\`\`

### Config Access

\`\`\`typescript
// [actual example from config.ts / a tool module]
\`\`\`

### Database Access

\`\`\`typescript
// [actual example showing which DB to use and try/finally pattern]
\`\`\`

---

## 6. Configuration Reference

[Table of all fields in massu.config.yaml with type and description]

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `toolPrefix` | string | `massu` | Prefix for all MCP tool names |
| [other fields from actual config] | | | |

---

## 7. DO NOT DO List (Common Mistakes)

| Anti-pattern | Why It Breaks | Correct Pattern |
|--------------|---------------|-----------------|
| `require('./module')` | Pattern scanner fails | `import { x } from './module.ts'` |
| `yaml.parse(fs.readFileSync(...))` | Bypasses config cache | `getConfig()` |
| Hardcoded `'massu_'` prefix | Won't work for other projects | `p('tool_name')` helper |
| `getMemoryDb()` without `finally` | Connection leak | `try { ... } finally { memDb.close(); }` |
| New tool not in tools.ts | Tool invisible to MCP clients | Wire into `getToolDefinitions()` + `handleToolCall()` |
| `process.exit()` in library code | Kills MCP server | Throw error instead |

---

## 8. Slash Command Reference

[Derived from .claude/commands/ directory]

| Command | Purpose | Edits Code? |
|---------|---------|-------------|
| `/massu-status` | Project health dashboard | NO |
| `/massu-create-plan` | Plan a feature | NO |
| `/massu-loop` | Implement a plan | YES |
| `/massu-commit` | Pre-commit gate | Fixes only |
| [additional commands from ls .claude/commands/] | | |

---

## 9. Testing Philosophy

[Derived from reading test files]

- Tests live in `packages/core/src/__tests__/`
- Framework: vitest
- Current count: [N] tests (from `npm test` output)
- Pattern: [derived from reading a test file]

---

## 10. Your First Week Checklist

- [ ] Run `npm test` — all [N] tests pass
- [ ] Run `bash scripts/massu-pattern-scanner.sh` — exits 0
- [ ] Read `massu.config.yaml` and understand all fields
- [ ] Read `packages/core/src/tools.ts` top-to-bottom
- [ ] Read one tool module end-to-end (e.g., `observability-tools.ts`)
- [ ] Run `/massu-status` and understand each health check
- [ ] Make a trivial change, run the gates, then revert it
```

---

## COMPLETION REPORT

```markdown
## CS ONBOARD COMPLETE

### Guide Generated
- **Role**: [role]
- **Sections**: [N]
- **Commands documented**: [N]
- **Patterns documented**: [N]

### Source Files Read
| File | Section Used In |
|------|----------------|
| [file] | [guide section] |

### Pitfalls Identified
| Pitfall | Source (where discovered) |
|---------|--------------------------|
| [pitfall] | [pattern scanner / code review] |

### Flags for Follow-up (CR-9)
| Issue | Location | Recommendation |
|-------|----------|----------------|
| [any broken pattern found] | [file] | [fix] |
```
