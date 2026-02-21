---
name: massu-import-audit
description: Import chain audit - prevents build issues from heavy/circular deps and ESM violations
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-import-audit

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# Massu Import Audit: Build Safety & Import Chain Compliance

## Objective

Prevent build failures and runtime crashes by auditing import chains across the codebase:
1. **ESM compliance**: All imports MUST use `.ts` extensions for local modules
2. **Hook safety**: Hook files MUST NOT import heavy dependencies
3. **Circular deps**: Circular imports MUST be eliminated
4. **Heavy package isolation**: Native/heavy packages MUST be properly handled

**Philosophy**: A single wrong import in a chain can cause build failures or runtime crashes. Prevention is cheaper than debugging.

---

## NON-NEGOTIABLE RULES

- **ESM extensions required** - Local imports must include `.ts` extension
- **Hooks are lightweight** - Hook files cannot import heavy packages (better-sqlite3, etc.)
- **No circular deps** - Circular imports cause undefined values at runtime
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - If ANY import violation is discovered - whether from current changes OR pre-existing - fix it immediately. Search entire codebase for same pattern and fix ALL instances.

---

## Section 1: Import Chain Analysis

### 1.1 Run Pattern Scanner Import Checks

```bash
bash scripts/massu-pattern-scanner.sh
# Expected: Exit 0 (no violations)
```

### 1.2 Check for ESM Extension Violations

```bash
# Find local imports missing .ts extension
grep -rn "from '\.\./\|from '\.\/" packages/core/src/ --include="*.ts" | grep -v "\.ts'" | grep -v __tests__ | grep -v node_modules
# Expected: 0 matches (all local imports have .ts extension)
```

### 1.3 Check for Heavy Package Imports in Hooks

```bash
# Hooks must be lightweight - check for forbidden imports
grep -rn "import.*from 'better-sqlite3'" packages/core/src/hooks/
grep -rn "import.*from '@modelcontextprotocol'" packages/core/src/hooks/
grep -rn "import.*from 'yaml'" packages/core/src/hooks/
# Expected: 0 matches in all cases
```

### 1.4 Import Safety Matrix

| Package | Allowed In | Not Allowed In | Notes |
|---------|-----------|---------------|-------|
| better-sqlite3 | src/*.ts | src/hooks/*.ts | Heavy native module |
| @modelcontextprotocol/sdk | server.ts, tools.ts | hooks/ | MCP runtime only |
| yaml | config.ts | hooks/ | Config parsing only |
| esbuild | build scripts | src/ runtime | Build tool only |

---

## Section 2: Circular Dependency Check

### 2.1 Detect Circular Imports

```bash
# Check for circular dependency issues
npx madge --circular packages/core/src/
# Expected: 0 circular dependencies
```

### 2.2 If Circular Dependencies Found

For each circular dependency:
1. Identify the cycle (A -> B -> C -> A)
2. Determine which import to break
3. Options: extract shared types, lazy import, dependency injection
4. Fix and re-verify

### 2.3 Circular Dependency Report

| Cycle | Files Involved | Fix Strategy |
|-------|---------------|-------------|
| Check required | - | - |

---

## Section 3: Hook Import Safety (CR-12)

### 3.1 Verify Hook Compilation

```bash
cd packages/core && npm run build:hooks
# Expected: Exit 0
```

### 3.2 Audit Hook Dependencies

```bash
# List all imports in hook files
grep -rn "^import\|^const.*require" packages/core/src/hooks/ | grep -v __tests__
```

For each import in a hook file, verify:
- Is it a Node.js built-in? (OK: fs, path, child_process)
- Is it a heavy package? (NOT OK: better-sqlite3, yaml, etc.)
- Is it a local import? (OK if the imported file is also lightweight)

### 3.3 Hook Import Matrix

| Hook File | Imports | Heavy? | Status |
|-----------|---------|--------|--------|
| Check required | - | - | - |

---

## Section 4: Dependency Weight Analysis

### 4.1 Check Package Sizes

```bash
# List direct dependencies with sizes
ls -la node_modules/.package-lock.json 2>/dev/null || echo "Check package.json"
```

### 4.2 Identify Heavy Transitive Dependencies

```bash
# Check for known heavy packages being pulled transitively
grep -rn "import.*from" packages/core/src/ --include="*.ts" | grep -v __tests__ | \
  sed "s/.*from '\([^']*\)'.*/\1/" | sort -u | grep -v '^\.'
```

---

## Section 5: Import Audit Report

### 5.1 Summary Report Format

```markdown
## Import Audit Report - [DATE]

### Critical Violations (Block Build)
- [file]: [import] - [reason]

### High Violations (Risk Build Failure)
- [file]: [import] - [reason]

### Medium Violations (Code Quality)
- [file]: [import] - [reason]

### Remediation Required
- [file]: [specific fix needed]
```

### 5.2 Fix Priority

| Risk | Examples | Fix |
|------|---------|-----|
| CRITICAL | Heavy import in hook file | Remove or use dynamic import |
| HIGH | Missing .ts extension | Add `.ts` extension |
| HIGH | Circular dependency | Break cycle |
| MEDIUM | Unused import | Remove import |

---

## Completion Criteria

- [ ] `bash scripts/massu-pattern-scanner.sh` exits 0
- [ ] `cd packages/core && npm run build:hooks` exits 0
- [ ] 0 local imports missing `.ts` extension
- [ ] 0 heavy package imports in hook files
- [ ] 0 circular dependencies
- [ ] `npm run build` exits 0

**Remember: A single wrong import can cause a build failure. Prevention costs minutes; debugging costs hours.**
