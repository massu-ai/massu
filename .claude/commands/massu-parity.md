---
name: massu-parity
description: Generic feature parity check between two systems or components
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*), Write(*), Task(*)
---
name: massu-parity

# Massu Parity: Feature Parity Check

## Purpose

Deep comparison between two systems, components, or versions to identify feature gaps, content drift, and update needs. Covers multiple layers -- source code, configuration, commands, hooks, tests, and operational tooling.

Run periodically (weekly recommended) or when comparing systems for migration/sync.

## Configuration

The user provides the two systems to compare. Default paths if not specified:

```
SOURCE_ROOT=[user-specified or prompted]
TARGET_ROOT=$(git rev-parse --show-toplevel)
```

---

## Step 1: Scan Recent Changes

Check source commits since last parity check (default: 7 days).

```bash
cd $SOURCE_ROOT && git log --oneline --since="7 days ago" | head -50
```

Note the commit count and summarize key infrastructure changes.

---

## Step 2: Top-Level Config Comparison (Layer 1)

### 2a. Compare configuration files

```bash
echo "=== Configuration Files ==="
for FILE in package.json tsconfig.json .claude/CLAUDE.md; do
  SEXISTS="NO"; TEXISTS="NO"
  [ -f "$SOURCE_ROOT/$FILE" ] && SEXISTS="YES ($(wc -c < "$SOURCE_ROOT/$FILE" | tr -d ' ')B)"
  [ -f "$TARGET_ROOT/$FILE" ] && TEXISTS="YES ($(wc -c < "$TARGET_ROOT/$FILE" | tr -d ' ')B)"
  echo "$FILE | Source: $SEXISTS | Target: $TEXISTS"
done
```

### 2b. Compare CLAUDE.md section headings

```bash
echo "=== SOURCE CLAUDE.md sections ==="
grep "^## " "$SOURCE_ROOT/.claude/CLAUDE.md" 2>/dev/null | head -30
echo ""
echo "=== TARGET CLAUDE.md sections ==="
grep "^## " "$TARGET_ROOT/.claude/CLAUDE.md" 2>/dev/null | head -30
```

---

## Step 3: Command Parity (Layer 2)

### 3a. List commands in both

```bash
echo "=== SOURCE COMMANDS ($(ls $SOURCE_ROOT/.claude/commands/*.md 2>/dev/null | wc -l | tr -d ' ')) ==="
ls $SOURCE_ROOT/.claude/commands/*.md 2>/dev/null | xargs -I{} basename {} | sort
echo ""
echo "=== TARGET COMMANDS ($(ls $TARGET_ROOT/.claude/commands/*.md 2>/dev/null | wc -l | tr -d ' ')) ==="
ls $TARGET_ROOT/.claude/commands/*.md 2>/dev/null | xargs -I{} basename {} | sort
```

### 3b. Find commands only in source / only in target

Compare normalized command names (strip prefixes) and report gaps.

### 3c. Compare matching commands for content drift

For each matching command pair, compare file sizes and modification dates. Flag significant drift (>50 lines difference).

---

## Step 4: Source Code Parity (Layer 3)

### 4a. Compare source file inventories

```bash
echo "=== Source Files ==="
echo "Source: $(find $SOURCE_ROOT -name '*.ts' -not -path '*/node_modules/*' -not -path '*/__tests__/*' | wc -l) files"
echo "Target: $(find $TARGET_ROOT -name '*.ts' -not -path '*/node_modules/*' -not -path '*/__tests__/*' | wc -l) files"
```

### 4b. Files only in source / only in target

List files that exist in one system but not the other.

### 4c. Compare matching files for drift

For matching files, report diff line counts.

---

## Step 5: Test Parity (Layer 4)

### 5a. Compare test file inventories

```bash
echo "=== Test Files ==="
echo "Source: $(find $SOURCE_ROOT -name '*.test.ts' -not -path '*/node_modules/*' | wc -l) tests"
echo "Target: $(find $TARGET_ROOT -name '*.test.ts' -not -path '*/node_modules/*' | wc -l) tests"
```

### 5b. Test files only in source / only in target

### 5c. Test drift for matching files

---

## Step 6: Hook & Script Parity (Layer 5)

### 6a. Compare hooks

```bash
echo "=== Hooks ==="
echo "Source:" && ls $SOURCE_ROOT/packages/core/src/hooks/*.ts 2>/dev/null | xargs -I{} basename {} || ls $SOURCE_ROOT/scripts/hooks/*.sh 2>/dev/null | xargs -I{} basename {}
echo "Target:" && ls $TARGET_ROOT/packages/core/src/hooks/*.ts 2>/dev/null | xargs -I{} basename {}
```

### 6b. Compare scripts

```bash
echo "=== Scripts ==="
echo "Source:" && ls $SOURCE_ROOT/scripts/*.sh 2>/dev/null | xargs -I{} basename {}
echo "Target:" && ls $TARGET_ROOT/scripts/*.sh 2>/dev/null | xargs -I{} basename {}
```

---

## Step 7: Tool/Feature Inventory Parity (Layer 6)

### 7a. Extract registered tool names from both systems

```bash
echo "=== SOURCE TOOLS ==="
grep -hE "name:\s*['\"\`]" $SOURCE_ROOT/packages/core/src/tools.ts $SOURCE_ROOT/packages/core/src/*-tools.ts $SOURCE_ROOT/packages/core/src/*.ts 2>/dev/null | head -40

echo ""
echo "=== TARGET TOOLS ==="
grep -hE "name:\s*['\"\`]" $TARGET_ROOT/packages/core/src/tools.ts $TARGET_ROOT/packages/core/src/*-tools.ts $TARGET_ROOT/packages/core/src/*.ts 2>/dev/null | head -40
```

### 7b. Compare tool inventories

Normalize tool names (strip prefixes) and diff.

---

## Step 8: Build Report

Create the full parity report at `docs/reports/PARITY_REPORT.md` with:

```markdown
# Feature Parity Report
**Date**: [today]
**Source**: [source system]
**Target**: [target system]
**Source Commits Since Last Check**: [count]
**Period**: Last 7 days

## Summary Scorecard

| Layer | Description | Source | Target | Parity % | Items Needing Update |
|-------|-------------|--------|--------|----------|---------------------|
| 1 | Config & CLAUDE.md | - | - | X% | [list] |
| 2 | Commands | N | N | X% | [list] |
| 3 | Source Code | N files | N files | X% | [list] |
| 4 | Tests | N | N | X% | [list] |
| 5 | Hooks & Scripts | N | N | X% | [list] |
| 6 | Tools/Features | N | N | X% | [list] |
| **Overall** | - | - | - | **X%** | **N total items** |

## Items Updated in Source, Not Yet in Target
[Table with layer, file, change description, priority]

## Items in Target but NOT in Source
[Table -- these are target innovations to preserve]

## Recommended Actions (Priority Order)
1. [action]
2. [action]
...
```

---

## Step 9: Present Summary

Show the user:
1. Overall parity percentage across all layers
2. Count of items needing update, broken down by priority
3. Top 10 priority actions
4. Link to full report

**Classification for each gap:**
- **CRITICAL**: Core functionality, security, session state
- **HIGH**: Safety features, hook functionality, config alignment
- **MEDIUM**: Additional commands, tests, scripts
- **LOW**: Nice-to-have, cosmetic differences

**Target-only items**: Items that exist in target but not source should be PRESERVED and noted as innovations. Do NOT recommend removing them for "parity" -- parity means target has everything source has, not that they are identical.
