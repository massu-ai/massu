---
name: massu-dead-code
description: Detect and remove dead code — orphaned modules, unused exports, unused dependencies
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-dead-code

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Massu Dead Code: Automated Dead Code Detection & Removal

## Objective

Identify and safely remove dead code (orphaned modules, unused exports, unused dependencies, unreferenced files) using manual verification and codebase analysis.

---

## NON-NEGOTIABLE RULES

- **Verify before removing** - grep for alternative import paths, barrel exports, dynamic imports
- **Blast radius analysis** - every removal gets a grep check for references
- **Build must pass after** - VR-BUILD + VR-TYPE mandatory after removals
- **No false positives** - if unsure, KEEP the code
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - if dead code reveals other issues, fix them too

---

## PROTOCOL

### Step 1: Inventory Source Files

```bash
# List all source files
find packages/core/src -name "*.ts" -not -path "*/__tests__/*" -not -path "*/node_modules/*" | sort

# List all exports
grep -rn "export " packages/core/src/ --include="*.ts" | grep -v "__tests__" | grep -v "node_modules"
```

### Step 2: Find Unused Exports

For each exported function/class/constant, check if it's imported elsewhere:

```bash
# For each export, verify it has importers
grep -rn "import.*[name]" packages/core/src/ --include="*.ts"
```

Cross-reference with `tools.ts` registrations - tool definitions and handlers are always "used" even if not directly imported elsewhere.

### Step 3: Categorize Findings

| Category | Source | Action |
|----------|--------|--------|
| ORPHANED_MODULE | No imports found | Verify not dynamically loaded, remove if truly orphaned |
| UNUSED_EXPORT | No importers | Check if used via re-export, remove if dead |
| UNUSED_DEPENDENCY | package.json | `npm uninstall` after verifying not dynamically required |
| UNUSED_FILE | No references | Verify no require() or dynamic import(), remove if dead |
| DEAD_FUNCTION | Never called | Verify not exported for external use, remove if dead |

### Step 4: Verify Each Finding

For EACH candidate removal:

```bash
# Check for all possible import patterns
grep -rn "import.*[name]" packages/core/src/ --include="*.ts"
grep -rn "require.*[name]" packages/core/src/ --include="*.ts"
grep -rn "[name]" packages/core/src/tools.ts
grep -rn "[name]" massu.config.yaml
```

If ANY reference found: KEEP (mark as false positive).
If NO references found: candidate for removal.

### Step 5: Present Removal Plan

```markdown
## Dead Code Removal Plan

| # | File/Export | Category | References Found | Action | Risk |
|---|------------|----------|-----------------|--------|------|
| 1 | packages/core/src/X.ts | ORPHAN | 0 | REMOVE | Low |
| 2 | lodash (dep) | UNUSED_DEP | 0 direct | UNINSTALL | Medium |
```

**WAIT FOR USER APPROVAL before executing removals.**

### Step 6: Execute Removals

After user approval:
1. Remove files/exports/dependencies
2. Run `npm run build` (VR-BUILD)
3. Run `cd packages/core && npx tsc --noEmit` (VR-TYPE)
4. Run `npm test` (VR-TEST)
5. Run `bash scripts/massu-pattern-scanner.sh`

### Step 7: Report

```markdown
## Dead Code Removal Report

- **Files removed**: N
- **Exports removed**: N
- **Dependencies uninstalled**: N
- **Build**: PASS
- **Types**: PASS
- **Tests**: PASS
```

---

## QUICK COMMANDS

```bash
# Check for unused dependencies
npx depcheck packages/core

# Pattern scanner (verify no violations introduced)
bash scripts/massu-pattern-scanner.sh

# Full build verification
npm run build

# Full test suite
npm test
```

---

**Remember: Dead code removal is a cleanup operation. When in doubt, keep the code.**
