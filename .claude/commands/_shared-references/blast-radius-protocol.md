# Shared Reference: Blast Radius Protocol

**This is a shared content block. Referenced by multiple commands. Do NOT invoke directly.**

---

## BLAST RADIUS ANALYSIS PROTOCOL (CR-25 — MANDATORY)

**MANDATORY** when ANY plan or change modifies a constant value, redirect path, route, string literal, enum value, or configuration key. See [incidents/INCIDENT-LOG.md](../../incidents/INCIDENT-LOG.md) Incident #15 for origin.

### Step 1: Identify ALL Changed Values

| # | Old Value | New Value | Type | Scope |
|---|-----------|-----------|------|-------|
| 1 | `[old]` | `[new]` | [redirect path / enum / route / config key] | codebase-wide |

### Step 2: Codebase-Wide Grep for EACH Changed Value

```bash
grep -rn '"[old_value]"' src/ --include="*.ts" --include="*.tsx" | grep -v node_modules
grep -rn "'[old_value]'" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules
grep -rn '"[old_value]"' src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | wc -l
```

### Step 2.5: Codegraph Impact Analysis

For each file found by grep, call `mcp__massu-codegraph__massu_impact({ file: "[relative_path]" })` to discover INDIRECT impact through import chains.

### Step 2.7: Sentinel Feature Impact (CR-32)

For plans that DELETE files, run `massu_sentinel_impact`. Every orphaned feature MUST have a migration target. Zero orphaned features allowed.

### Step 3: Categorize EVERY Occurrence

**EVERY match must be categorized. No exceptions.**

| # | File | Line | Context | Action | Reason |
|---|------|------|---------|--------|--------|
| 1 | src/middleware.ts | 523 | Root redirect | CHANGE | Landing page |
| 2 | src/components/Sidebar.tsx | 93 | Nav href | KEEP | Links TO target |

**Disposition Summary**: Count of CHANGE / KEEP / INVESTIGATE items. INVESTIGATE must resolve to 0 before plan is final.

### Step 4: Add ALL "CHANGE" Items to Plan

Every "CHANGE" occurrence becomes a plan deliverable with item ID, file, change required, and phase.

### Automated Blast Radius Analysis (Optional)

Spawn `Task(subagent_type="massu-blast-radius-analyzer", prompt="Analyze blast radius for value changes: {old_value} -> {new_value}. Categorize every occurrence.")` for automated codebase-wide grep, codegraph impact tracing, and automatic categorization.

---

## Blast Radius Gate

All of the following must be true:
- All changed values identified
- Grep run for each value
- Every occurrence categorized
- Zero INVESTIGATE remaining
- All CHANGE items in plan
- All KEEP items documented with reasons

**BLAST RADIUS GATE: PASS / FAIL**

---

## Common Search Patterns

| Change Type | Search Patterns |
|-------------|-----------------|
| Route/path | `href="[old]"`, `push('[old]')`, `replace('[old]')`, `redirect('[old]')`, `pathname === '[old]'` |
| Status/enum | `=== '[old]'`, `value="[old]"`, `status: '[old]'` |
| Table/column rename | `ctx.db.[old]`, `[old]_id`, `table_name = '[old]'` |
| Component rename | `<[Old]`, `import.*[Old]`, `from.*[old]` |
| Config key | `config.[old]`, `[old]:`, `"[old]"` |
