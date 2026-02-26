---
name: massu-docs
description: Documentation sync protocol ensuring docs align with code changes and features
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-docs

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Massu Docs: Documentation Sync Protocol

## Objective

Ensure **documentation accuracy** by auditing documentation content against current codebase features, CLI elements, and workflows. Keep help articles, CLAUDE.md, and API docs in sync with code changes.

---

## NON-NEGOTIABLE RULES

- **Code is truth** - Docs must match actual behavior
- **Feature parity** - Every user feature needs docs
- **Terminology sync** - Same labels in CLI output and docs
- **Version awareness** - Document breaking changes
- **No assumptions** - Verify features exist before documenting

---

## ZERO-GAP AUDIT LOOP

**Documentation sync does NOT complete until a SINGLE COMPLETE AUDIT finds ZERO discrepancies.**

### The Rule

```
DOCS AUDIT LOOP:
  1. Run ALL documentation checks (features, terminology, API)
  2. Count discrepancies found
  3. IF discrepancies > 0:
       - Fix ALL discrepancies
       - Re-run ENTIRE audit from Step 1
  4. IF discrepancies == 0:
       - DOCS IN SYNC
```

**Partial re-checks are NOT valid. The ENTIRE docs audit must pass in a SINGLE run.**

---

## DOCUMENTATION LOCATIONS

| Type | Location | Purpose |
|------|----------|---------|
| CLAUDE.md | `.claude/CLAUDE.md` | AI assistant context and project rules |
| Config docs | `massu.config.yaml` comments | Config schema documentation |
| README | `packages/core/README.md` | Public-facing package docs |
| Website docs | `website/` (if applicable) | User-facing documentation site |
| Command files | `.claude/commands/*.md` | Workflow command documentation |
| Plans | `docs/plans/*.md` | Implementation plans and specs |

---

## AUDIT SECTION 1: FEATURE INVENTORY

### 1.1 List All MCP Tools (User-Facing Features)
```bash
# Find all tool definitions
grep -rn "name:" packages/core/src/tools.ts packages/core/src/*-tools.ts packages/core/src/*.ts 2>/dev/null \
  | grep -E "name:\s*[\`'\"]" \
  | grep -v "__tests__" \
  | head -40

# Count tools
grep -c "name:" packages/core/src/tools.ts 2>/dev/null
```

### 1.2 Feature Matrix
```markdown
### Feature Inventory

| Feature/Tool | Module | Documented in README | Documented in CLAUDE.md | Status |
|-------------|--------|---------------------|------------------------|--------|
| [tool] | [module] | YES/NO | YES/NO | OK/NEEDS DOC |
```

### 1.3 Find Undocumented Features
Compare tools found in codebase against README documentation.

---

## AUDIT SECTION 2: CLI/TOOL OUTPUT SYNC

### 2.1 Extract Tool Output Strings
```bash
# Find tool output text
grep -rn "text:" packages/core/src/ --include="*.ts" | grep -v "__tests__" | head -30

# Find error messages
grep -rn "Error\|error\|Invalid\|invalid" packages/core/src/ --include="*.ts" | grep -v "__tests__" | head -20
```

### 2.2 Terminology Matrix
```markdown
### Tool Output Terminology Audit

| Tool | Output String | Docs String | Match | Status |
|------|--------------|-------------|-------|--------|
| [tool] | [code] | [docs] | YES/NO | OK/FIX |
```

---

## AUDIT SECTION 3: WORKFLOW DOCUMENTATION

### 3.1 Identify User Workflows
```bash
# Find all command files (these define workflows)
ls .claude/commands/massu-*.md | wc -l

# Find workflow references in CLAUDE.md
grep "massu-" .claude/CLAUDE.md | head -30
```

### 3.2 Workflow Matrix
```markdown
### Workflow Documentation

| Workflow | Command File | In CLAUDE.md | Steps Match | Status |
|----------|-------------|--------------|-------------|--------|
| Implementation | massu-loop.md | YES | YES/NO | OK/UPDATE |
| Commit | massu-commit.md | YES | YES/NO | OK/UPDATE |
```

### 3.3 Verify Command Table in CLAUDE.md

Compare the Workflow Commands tables in CLAUDE.md against actual command files:
```bash
# Count commands in CLAUDE.md table
grep -c "massu-" .claude/CLAUDE.md

# Count actual command files
ls .claude/commands/massu-*.md | wc -l
```

**CRITICAL**: Every command file MUST be listed in the CLAUDE.md Workflow Commands tables.

---

## AUDIT SECTION 4: API/CONFIG DOCUMENTATION

### 4.1 Config Schema Documentation
```bash
# Check massu.config.yaml has comments explaining fields
grep -c "#" massu.config.yaml

# Check config.ts documents the schema
grep -c "description\|comment\|//" packages/core/src/config.ts
```

### 4.2 API Documentation
```bash
# Check if tool inputSchema has descriptions for all properties
grep -rn "description:" packages/core/src/ --include="*.ts" | grep -v "__tests__" | wc -l
```

### 4.3 Config Documentation Matrix
```markdown
### Config Documentation

| Config Key | Documented in YAML | Documented in README | Type Correct | Status |
|-----------|-------------------|---------------------|--------------|--------|
| [key] | YES/NO | YES/NO | YES/NO | OK/FIX |
```

---

## AUDIT SECTION 5: README ACCURACY

### 5.1 Check README Contents
```bash
# Read public README
cat packages/core/README.md 2>/dev/null | head -50

# Check if README mentions all key features
grep -c "tool\|hook\|config\|install\|usage" packages/core/README.md 2>/dev/null
```

### 5.2 README Sections Checklist
```markdown
### README Completeness

| Section | Present | Accurate | Status |
|---------|---------|----------|--------|
| Installation | YES/NO | YES/NO | OK/FIX |
| Configuration | YES/NO | YES/NO | OK/FIX |
| Usage | YES/NO | YES/NO | OK/FIX |
| Tools Reference | YES/NO | YES/NO | OK/FIX |
| Contributing | YES/NO | YES/NO | OK/FIX |
```

---

## AUDIT SECTION 6: DEVELOPER DOCS SYNC

### 6.1 CLAUDE.md Accuracy
```bash
# Check if CLAUDE.md file locations match actual
grep "packages/core/src/" .claude/CLAUDE.md | while read line; do
  path=$(echo "$line" | grep -oP 'packages/core/src/[a-zA-Z0-9_./-]+')
  if [ -n "$path" ]; then
    [ -f "$path" ] && echo "OK: $path" || echo "MISSING: $path"
  fi
done

# Verify tool module inventory matches actual files
grep -c "\.ts" .claude/CLAUDE.md
```

### 6.2 Build & Test Commands Accuracy
```bash
# Verify each documented build command works
npm run build --dry-run 2>/dev/null
npm test --help 2>/dev/null
```

### 6.3 Developer Docs Matrix
```markdown
### Developer Documentation

| Doc | Last Updated | Accurate | Status |
|-----|--------------|----------|--------|
| CLAUDE.md | [date] | YES/NO | OK/UPDATE |
| massu.config.yaml | [date] | YES/NO | OK/UPDATE |
| README.md | [date] | YES/NO | OK/UPDATE |
```

---

## SYNC PROCESS

### When Code Changes

1. **Identify impact**
   - What feature/tool changed?
   - What CLI output changed?
   - What workflows changed?

2. **Find related docs**
   - Search README for feature mentions
   - Search CLAUDE.md for related rules
   - Search command files for related references

3. **Update docs**
   - Change terminology if labels changed
   - Update steps if workflow changed
   - Update examples if API changed
   - Update CLAUDE.md tables if commands added/removed

4. **Verify sync**
   - Re-read updated docs
   - Compare against actual behavior
   - Run documented commands to verify accuracy

---

## DOCS SYNC REPORT FORMAT

```markdown
## MASSU DOCS SYNC REPORT

### Summary
- **Date**: [timestamp]
- **Scope**: Full sync / [specific area]
- **Features Audited**: [N]
- **Issues Found**: [N]

### Feature Coverage
| Status | Count |
|--------|-------|
| Documented | N |
| Undocumented | N |
| Outdated | N |

### Terminology Sync
| Status | Count |
|--------|-------|
| Matching | N |
| Mismatched | N |

### Issues Found
| Priority | Issue | Location | Fix |
|----------|-------|----------|-----|
| HIGH | [issue] | [loc] | [fix] |

### Updates Applied
- [Update 1]
- [Update 2]

### Recommendations
1. [Recommendation 1]
2. [Recommendation 2]

**DOCS STATUS: IN SYNC / NEEDS UPDATE / CRITICAL**
```

---

## SESSION STATE UPDATE

After sync, update `session-state/CURRENT.md`:

```markdown
## DOCS SYNC SESSION

### Audit
- **Date**: [timestamp]
- **Scope**: Full / [specific area]

### Findings
- Undocumented features: [N]
- Outdated docs: [N]
- Terminology mismatches: [N]

### Updates Applied
[List or "None - audit only"]

### Status
- README: IN SYNC / NEEDS UPDATE
- CLAUDE.md: IN SYNC / NEEDS UPDATE
- Config docs: IN SYNC / NEEDS UPDATE
```

---

## QUICK COMMANDS

```bash
# List all MCP tools (potential doc topics)
grep -rn "name:" packages/core/src/tools.ts | head -20

# Check CLAUDE.md freshness
ls -la .claude/CLAUDE.md

# List command files
ls -la .claude/commands/massu-*.md | wc -l

# Search docs for term
grep -rn "[search term]" packages/core/README.md .claude/CLAUDE.md 2>/dev/null
```

---

## START NOW

1. Run Section 1: Feature Inventory
2. Run Section 2: CLI/Tool Output Sync
3. Run Section 3: Workflow Documentation
4. Run Section 4: API/Config Documentation
5. Run Section 5: README Accuracy
6. Run Section 6: Developer Docs Sync
7. Apply necessary updates
8. Produce Docs Sync Report
9. Update session state

**Remember: Documentation is a product. Outdated docs = broken product.**
