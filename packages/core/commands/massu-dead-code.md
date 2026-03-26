---
name: massu-dead-code
description: "When user asks about unused code, says 'find dead code', 'clean up unused', or wants to reduce codebase size by removing unreferenced exports"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-dead-code

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding.

# Massu Dead Code: Automated Dead Code Detection & Removal

## Objective

Identify and safely remove dead code (orphaned components, unused exports, unused dependencies, unreferenced files) using a combination of knip, audit-dead-code.sh, and manual verification.

---

## NON-NEGOTIABLE RULES

- **Verify before removing** - grep for alternative import paths, barrel exports, dynamic imports
- **Blast radius analysis** - every removal gets a grep check for references
- **Build must pass after** - VR-BUILD + VR-TYPE mandatory after removals
- **No false positives** - if unsure, KEEP the code
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - if dead code reveals other issues, fix them too

---

## PROTOCOL

### Step 1: Run knip

```bash
npm run knip 2>&1 | tee /tmp/knip-output.txt
```

Capture counts: unused files, unused dependencies, unused exports, unused types.

### Step 2: Run audit-dead-code.sh

```bash
./scripts/audit-dead-code.sh 2>&1 | tee /tmp/dead-code-audit.txt
```

Cross-reference with knip findings.

### Step 3: Categorize Findings

| Category | Source | Action |
|----------|--------|--------|
| ORPHANED_COMPONENT | knip + audit | Verify no dynamic imports, remove if truly orphaned |
| UNUSED_EXPORT | knip | Check if used via barrel re-export, remove if dead |
| UNUSED_DEPENDENCY | knip | `npm uninstall` after verifying not dynamically required |
| UNUSED_FILE | knip | Verify no require() or dynamic import(), remove if dead |
| DEAD_PROCEDURE | audit | Verify not called from any UI, remove if dead |

### Step 4: Verify Each Finding

For EACH candidate removal:

```bash
# Check for all possible import patterns
grep -rn "import.*[name]" src/ --include="*.ts" --include="*.tsx"
grep -rn "require.*[name]" src/ --include="*.ts" --include="*.tsx"
grep -rn "dynamic.*import.*[name]" src/ --include="*.ts" --include="*.tsx"
grep -rn "<[ComponentName]" src/ --include="*.tsx"
```

If ANY reference found: KEEP (mark as false positive).
If NO references found: candidate for removal.

### Step 5: Present Removal Plan

```markdown
## Dead Code Removal Plan

| # | File/Export | Category | References Found | Action | Risk |
|---|------------|----------|-----------------|--------|------|
| 1 | src/components/X.tsx | ORPHAN | 0 | REMOVE | Low |
| 2 | lodash (dep) | UNUSED_DEP | 0 direct | UNINSTALL | Medium |
```

**WAIT FOR USER APPROVAL before executing removals.**

### Step 6: Execute Removals

After user approval:
1. Remove files/exports/dependencies
2. Run `npm run build` (VR-BUILD)
3. Run `npx tsc --noEmit` (VR-TYPE)
4. Run `npm test` (VR-TEST)
5. Run `./scripts/pattern-scanner.sh`

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
# Full knip report
npm run knip

# Strict mode (fails on any issue)
npm run knip:strict

# Existing dead code audit
./scripts/audit-dead-code.sh

# Pattern scanner (verify no violations introduced)
./scripts/pattern-scanner.sh
```

---

**Remember: Dead code removal is a cleanup operation. When in doubt, keep the code.**
