---
name: massu-feature-parity
description: "Comprehensive Feature Parity Check: Massu vs Limn Systems source"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*), Write(*), Task(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Feature Parity Check: Massu vs Limn Systems

## Purpose

Deep comparison of Massu against the Limn Systems source to identify feature gaps, content drift, and update needs. Covers 7 layers: commands, hooks, agents, settings, KB structure, MCP source code, and infrastructure.

Run periodically (weekly recommended) to maintain 100% feature parity.

## Configuration

```
# Override via environment variables or $ARGUMENTS
LIMN_ROOT="${LIMN_ROOT:-${ARGUMENTS:-/path/to/limn-systems}}"
LIMN_MCP="$LIMN_ROOT/scripts/mcp/limn-codegraph"
LIMN_CLAUDE="$LIMN_ROOT/.claude"
MASSU_ROOT="${MASSU_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
MASSU_MCP="$MASSU_ROOT/packages/core/src"
MASSU_CLAUDE="$MASSU_ROOT/.claude"
```

---

## Step 1: Scan Recent Changes

Check Limn commits since last parity check (default: 7 days).

```bash
cd $LIMN_ROOT && git log --oneline --since="7 days ago" -- '.claude/' 'scripts/hooks/' 'scripts/mcp/limn-codegraph/' | head -50
```

Note the commit count and summarize key infrastructure changes (ignore app-specific commits).

---

## Step 2: Command Parity (Layer 1)

### 2a. List commands in both

```bash
echo "=== LIMN COMMANDS ===" && ls $LIMN_CLAUDE/commands/*.md | xargs -I{} basename {} | sort
echo "=== MASSU COMMANDS ===" && ls $MASSU_CLAUDE/commands/*.md | xargs -I{} basename {} | sort
```

### 2b. Find commands only in Limn (potential additions)

```bash
diff <(ls $LIMN_CLAUDE/commands/*.md | xargs -I{} basename {} .md | sed 's/^limn-//' | sort) \
     <(ls $MASSU_CLAUDE/commands/*.md | xargs -I{} basename {} .md | sed 's/^massu-//' | sort) \
     | grep "^<" | sed 's/^< //'
```

### 2c. Find commands only in Massu

```bash
diff <(ls $LIMN_CLAUDE/commands/*.md | xargs -I{} basename {} .md | sed 's/^limn-//' | sort) \
     <(ls $MASSU_CLAUDE/commands/*.md | xargs -I{} basename {} .md | sed 's/^massu-//' | sort) \
     | grep "^>" | sed 's/^> //'
```

### 2d. Compare matching commands for content drift

For each matching pair (e.g., limn-commit/massu-commit), compare file sizes and check if the Limn version has been updated more recently:

```bash
for CMD in commit create-plan debug hotfix loop migrate perf plan push refactor test; do
  LIMN_FILE="$LIMN_CLAUDE/commands/limn-$CMD.md"
  MASSU_FILE="$MASSU_CLAUDE/commands/massu-$CMD.md"
  if [ -f "$LIMN_FILE" ] && [ -f "$MASSU_FILE" ]; then
    LSIZE=$(wc -c < "$LIMN_FILE" | tr -d ' ')
    MSIZE=$(wc -c < "$MASSU_FILE" | tr -d ' ')
    LMOD=$(stat -f '%Sm' -t '%Y-%m-%d' "$LIMN_FILE")
    MMOD=$(stat -f '%Sm' -t '%Y-%m-%d' "$MASSU_FILE")
    echo "$CMD | Limn: ${LSIZE}B ($LMOD) | Massu: ${MSIZE}B ($MMOD)"
  fi
done
```

### 2e. Check shared preamble

```bash
echo "=== Shared Preamble ==="
[ -f "$LIMN_CLAUDE/commands/_shared-preamble.md" ] && echo "Limn: EXISTS ($(wc -c < "$LIMN_CLAUDE/commands/_shared-preamble.md" | tr -d ' ')B)" || echo "Limn: MISSING"
[ -f "$MASSU_CLAUDE/commands/_shared-preamble.md" ] && echo "Massu: EXISTS ($(wc -c < "$MASSU_CLAUDE/commands/_shared-preamble.md" | tr -d ' ')B)" || echo "Massu: MISSING"
```

---

## Step 3: Hook Parity (Layer 2)

### 3a. TypeScript hooks (compiled into MCP)

```bash
echo "=== LIMN HOOKS ===" && ls $LIMN_MCP/hooks/*.ts | xargs -I{} basename {}
echo "=== MASSU HOOKS ===" && ls $MASSU_MCP/hooks/*.ts | xargs -I{} basename {}
```

### 3b. Compare matching hooks for drift

```bash
for HOOK in post-edit-context post-tool-use pre-compact pre-delete-check session-end session-start user-prompt; do
  LIMN_FILE="$LIMN_MCP/hooks/$HOOK.ts"
  MASSU_FILE="$MASSU_MCP/hooks/$HOOK.ts"
  if [ -f "$LIMN_FILE" ] && [ -f "$MASSU_FILE" ]; then
    DIFF=$(diff "$LIMN_FILE" "$MASSU_FILE" 2>/dev/null | wc -l | tr -d ' ')
    LSIZE=$(wc -c < "$LIMN_FILE" | tr -d ' ')
    MSIZE=$(wc -c < "$MASSU_FILE" | tr -d ' ')
    echo "$HOOK.ts | Limn: ${LSIZE}B | Massu: ${MSIZE}B | Diff: $DIFF lines"
  fi
done
```

### 3c. Shell hooks (Limn scripts/hooks/)

```bash
echo "=== LIMN SHELL HOOKS ===" && ls $LIMN_ROOT/scripts/hooks/*.sh | xargs -I{} basename {}
echo "(Massu equivalent: check if functionality is covered by TypeScript hooks)"
```

---

## Step 4: Agent Parity (Layer 3)

```bash
echo "=== LIMN AGENTS ===" && ls ~/.claude/agents/*.md | xargs -I{} basename {} .md
echo "=== MASSU AGENTS ===" && ls $MASSU_CLAUDE/agents/*.md 2>/dev/null | xargs -I{} basename {} .md || echo "(none)"
```

All Limn agents should have generalized Massu equivalents.

---

## Step 5: Settings/Configuration Parity (Layer 4)

### 5a. Compare settings.json hook wiring

```bash
echo "=== LIMN SETTINGS HOOKS ==="
cat ~/.claude/settings.json | python3 -c "import json,sys; d=json.load(sys.stdin); hooks=d.get('hooks',{}); [print(f'{k}: {len(v)} hooks') for k,v in hooks.items()]" 2>/dev/null

echo "=== MASSU SETTINGS HOOKS ==="
cat $MASSU_CLAUDE/settings.json | python3 -c "import json,sys; d=json.load(sys.stdin); hooks=d.get('hooks',{}); [print(f'{k}: {len(v)} hooks') for k,v in hooks.items()]" 2>/dev/null
```

### 5b. Check for statusLine

```bash
grep -c "statusLine" ~/.claude/settings.json $MASSU_CLAUDE/settings.json 2>/dev/null
```

---

## Step 6: Knowledge Base Structure Parity (Layer 5)

```bash
echo "=== LIMN KB STRUCTURE ==="
for DIR in protocols playbooks patterns checklists critical reference incidents scripts; do
  COUNT=$(ls $LIMN_CLAUDE/$DIR/ 2>/dev/null | wc -l | tr -d ' ')
  echo "$DIR/: $COUNT files"
done

echo "=== MASSU KB STRUCTURE ==="
for DIR in protocols playbooks patterns checklists critical reference incidents scripts; do
  COUNT=$(ls $MASSU_CLAUDE/$DIR/ 2>/dev/null | wc -l | tr -d ' ')
  echo "$DIR/: $COUNT files"
done
```

---

## Step 7: MCP Source Code Parity (Layer 6)

### 7a. Compare all shared TypeScript source files

```bash
for f in $(ls $LIMN_MCP/*.ts | xargs -I{} basename {}); do
  if [ -f "$MASSU_MCP/$f" ]; then
    DIFF=$(diff "$LIMN_MCP/$f" "$MASSU_MCP/$f" 2>/dev/null | wc -l | tr -d ' ')
    LMOD=$(stat -f '%Sm' -t '%Y-%m-%d' "$LIMN_MCP/$f")
    MMOD=$(stat -f '%Sm' -t '%Y-%m-%d' "$MASSU_MCP/$f")
    [ "$DIFF" -gt 0 ] && echo "$f | Diff: $DIFF lines | Limn: $LMOD | Massu: $MMOD"
  fi
done
```

### 7b. Files only in Limn MCP (missing from Massu)

```bash
for f in $(ls $LIMN_MCP/*.ts | xargs -I{} basename {}); do
  [ ! -f "$MASSU_MCP/$f" ] && echo "MISSING in Massu: $f"
done
```

### 7c. Files only in Massu (unique to Massu)

```bash
for f in $(ls $MASSU_MCP/*.ts | xargs -I{} basename {}); do
  [ ! -f "$LIMN_MCP/$f" ] && echo "Massu-only: $f"
done
```

---

## Step 8: Skills Parity (Layer 7)

```bash
echo "=== LIMN SKILLS ===" && ls ~/.claude/skills/*.md 2>/dev/null | xargs -I{} basename {} .md || echo "(none)"
echo "=== MASSU SKILLS ===" && ls $MASSU_ROOT/skills/*.md 2>/dev/null | xargs -I{} basename {} .md || echo "(none)"
```

---

## Step 9: Build Report

Create the full parity report at `docs/reports/PARITY_REPORT.md` with:

```markdown
# Feature Parity Report
**Date**: [today]
**Limn Commits Since Last Check**: [count]
**Period**: Last 7 days

## Summary Scorecard

| Layer | Limn | Massu | Parity % | Items Needing Update |
|-------|------|-------|----------|---------------------|
| Commands | N | N | X% | [list] |
| Hooks (TS) | N | N | X% | [list] |
| Hooks (Shell/Settings) | N | N | X% | [list] |
| Agents | N | N | X% | [list] |
| KB Structure | N dirs | N dirs | X% | [list] |
| MCP Source | N files | N files | X% | [list with diff lines] |
| Skills | N | N | X% | [list] |
| **Overall** | - | - | **X%** | **N total items** |

## Critical Updates (Past 7 Days)
[List changes from Step 1 that affect Massu]

## Items Updated in Limn, Not Yet in Massu
[Table with file, change description, priority]

## Items in Massu but NOT in Limn
[Table with file, notes]

## Recommended Actions (Priority Order)
1. [action]
2. [action]
...
```

---

## Step 10: Present Summary

Show the user:
1. Overall parity percentage across all 7 layers
2. Count of items needing update
3. Top 5 priority actions
4. Link to full report

**Classification for each gap:**
- **CRITICAL**: Core functionality, pricing/cost data, crash/hang fixes
- **HIGH**: Context optimization, safety features, agent capabilities
- **MEDIUM**: Additional commands, KB templates, shell hooks
- **LOW**: Nice-to-have, cosmetic differences
