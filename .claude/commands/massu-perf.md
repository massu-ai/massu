---
name: massu-perf
description: Performance analysis — bundle size, lazy-loading, query optimization, edge function sizing
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# CS Perf: Performance Analysis

## Objective

Comprehensive READ-ONLY performance analysis across the entire codebase. Covers bundle size, loading states, database queries, edge functions, image optimization, and MCP server performance. No files are modified.

**Usage**: `/massu-perf` (full analysis) or `/massu-perf [area]` (focused: bundle, queries, edge, components, images, mcp)

## Workflow Position

Performance analysis is a diagnostic command. It does NOT modify source code directly but produces actionable recommendations.

```
/massu-perf [target]  ->  analysis report  ->  /massu-create-plan (if changes needed)
```

---

## NON-NEGOTIABLE RULES

- Do NOT modify any files
- Do NOT fix any issues found (report only)
- Report ALL findings with impact classification
- Run ALL checks even if early ones find issues
- Provide specific, actionable recommendations

---

## CHECK 1: BUNDLE ANALYSIS (website)

```bash
# Build and capture output
cd website && npx next build 2>&1 | tail -40
```

If build output available, parse route sizes:

```bash
# Check for bundle analyzer output
ls -la website/.next/analyze/ 2>/dev/null || echo "No analyzer output found"

# Parse build output for route sizes
# Look for "Route (app)" section and identify large routes
```

### Bundle Thresholds

| Metric | Good | Warning | Critical |
|--------|------|---------|----------|
| Route first-load JS | < 100 KB | 100-200 KB | > 200 KB |
| Shared chunks | < 200 KB | 200-400 KB | > 400 KB |

### Heavy Dependencies Check

```bash
# Check for heavy imports that should use dynamic import
grep -rn "import.*from.*recharts\|import.*from.*@react-pdf\|import.*from.*monaco-editor\|import.*from.*d3\|import.*from.*chart.js" \
  website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null

# Check for dynamic imports (good pattern)
grep -rn "dynamic(\|React\.lazy\|import(" website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null | head -20
```

```markdown
### Bundle Analysis

| Route | First-Load JS | Status |
|-------|--------------|--------|
| [route] | [size] | GOOD/WARN/CRITICAL |

### Heavy Dependencies
| Import | File | Dynamic? | Recommendation |
|--------|------|----------|----------------|
| [lib] | [file] | YES/NO | [rec] |
```

---

## CHECK 2: LOADING STATE COVERAGE (website)

```bash
# List all page directories under dashboard
find website/src/app/dashboard -name "page.tsx" 2>/dev/null | while read page; do
  DIR=$(dirname "$page")
  if [ -f "$DIR/loading.tsx" ]; then
    echo "HAS_LOADING: $DIR"
  else
    echo "MISSING_LOADING: $DIR"
  fi
done

# Also check top-level app routes
find website/src/app -maxdepth 2 -name "page.tsx" 2>/dev/null | while read page; do
  DIR=$(dirname "$page")
  if [ -f "$DIR/loading.tsx" ]; then
    echo "HAS_LOADING: $DIR"
  else
    echo "MISSING_LOADING: $DIR"
  fi
done
```

```markdown
### Loading State Coverage

| Page Directory | loading.tsx | Status |
|---------------|-------------|--------|
| [dir] | YES/NO | PASS/WARN |

**Coverage**: [N]/[N] pages have loading states ([N]%)
```

---

## CHECK 3: DATABASE QUERY PATTERNS (website)

### 3.1 Select All Columns Antipattern

```bash
# Find .select('*') usage — should select specific columns
grep -rn "\.select(['\"]\\*['\"])" website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null
```

### 3.2 Unbounded Queries

```bash
# Find queries without .limit()
# Look for .select() calls not followed by .limit() in the same chain
grep -rn "\.select(" website/src/lib/ --include="*.ts" 2>/dev/null | grep -v '\.limit\|\.single\|\.maybeSingle'
```

### 3.3 Sequential Queries (Parallelization Opportunities)

```bash
# Find multiple sequential await calls to supabase
grep -n 'await.*supabase\|await.*\.from(' website/src/ --include="*.ts" --include="*.tsx" -r 2>/dev/null | head -30
```

### 3.4 N+1 Query Patterns

```bash
# Find loops containing database queries
grep -B5 -A2 'for.*{$\|forEach\|\.map(' website/src/ --include="*.ts" --include="*.tsx" -r 2>/dev/null | grep -A5 'supabase\|\.from('
```

### 3.5 Missing Index Analysis

```bash
# Extract WHERE clauses and compare against migration indexes
grep -rn '\.eq(\|\.filter(\|\.match(' website/src/lib/ --include="*.ts" 2>/dev/null | head -20

# List all indexes from migrations
grep -rn 'CREATE INDEX' website/supabase/migrations/*.sql 2>/dev/null
```

```markdown
### Query Pattern Analysis

| Pattern | File:Line | Severity | Description | Recommendation |
|---------|-----------|----------|-------------|----------------|
| SELECT * | [loc] | MEDIUM | Select all columns | Specify needed columns |
| Unbounded | [loc] | HIGH | No .limit() on list query | Add .limit() |
| Sequential | [loc] | MEDIUM | Sequential queries | Use Promise.all() |
| N+1 | [loc] | HIGH | Query inside loop | Use .in() filter |
| Missing Index | [loc] | MEDIUM | WHERE without index | Add index in migration |
```

---

## CHECK 4: EDGE FUNCTION SIZING (website)

```bash
# List edge functions and their sizes
if [ -d "website/supabase/functions" ]; then
  for func in website/supabase/functions/*/; do
    FUNC_NAME=$(basename "$func")
    if [ -f "$func/index.ts" ]; then
      SIZE=$(wc -c < "$func/index.ts")
      echo "$FUNC_NAME: $SIZE bytes"
    fi
    # Check for heavy imports
    grep -c 'import' "$func/index.ts" 2>/dev/null | while read count; do
      echo "  Imports: $count"
    done
  done
else
  echo "No edge functions directory found"
fi
```

### Edge Function Thresholds

| Metric | Good | Warning | Critical |
|--------|------|---------|----------|
| Function size | < 20 KB | 20-50 KB | > 50 KB |
| Import count | < 10 | 10-20 | > 20 |

```markdown
### Edge Function Inventory

| Function | Size | Imports | Status |
|----------|------|---------|--------|
| [name] | [size] | [N] | GOOD/WARN/CRITICAL |
```

---

## CHECK 5: IMAGE OPTIMIZATION (website)

```bash
# Find <img> tags without next/image wrapper
grep -rn '<img ' website/src/ --include="*.tsx" 2>/dev/null | grep -v 'next/image'

# Check for large static assets
find website/public -type f -size +500k 2>/dev/null -exec ls -lh {} \;

# Verify next/image usage has proper width/height
grep -rn 'Image' website/src/ --include="*.tsx" 2>/dev/null | grep -v 'width\|fill' | grep 'from.*next/image'

# Check for unoptimized images
grep -rn 'unoptimized' website/src/ --include="*.tsx" 2>/dev/null
```

```markdown
### Image Optimization

| Issue | File:Line | Details | Recommendation |
|-------|-----------|---------|----------------|
| Raw <img> | [loc] | Not using next/image | Use Image from next/image |
| Large asset | [path] | [size] | Compress or use CDN |
| Missing dimensions | [loc] | No width/height | Add explicit dimensions |
```

---

## CHECK 6: MCP SERVER PERFORMANCE (packages/core)

### 6.1 Synchronous File Operations

```bash
# Check for sync file reads in tool handlers (should be async or minimal)
grep -rn 'readFileSync\|writeFileSync' packages/core/src/ --include="*.ts" 2>/dev/null | grep -v '__tests__\|hooks'
```

### 6.2 SQLite Query Patterns

```bash
# Check for missing indexes in memory-db schema
grep -A5 'CREATE TABLE' packages/core/src/memory-db.ts 2>/dev/null
# Check for queries that might need indexes
grep -rn '\.prepare(' packages/core/src/ --include="*.ts" 2>/dev/null | grep 'WHERE' | head -20
```

### 6.3 Connection Leak Detection

```bash
# Verify memDb.close() is always called in try/finally
grep -B10 'memDb' packages/core/src/tools.ts 2>/dev/null | grep -c 'finally'
grep -c 'getMemoryDb()' packages/core/src/tools.ts 2>/dev/null
# These counts should match (every getMemoryDb has a finally/close)
```

### 6.4 Tool Module Count and Startup

```bash
# Count tool modules
grep -c 'ToolDefinitions()' packages/core/src/tools.ts 2>/dev/null

# Count total tools
grep -c "name:" packages/core/src/tools.ts 2>/dev/null

# Estimated startup impact: more modules = slower first tool list
echo "Tool modules loaded at startup — each adds to initial response time"
```

```markdown
### MCP Server Performance

| Check | Finding | Impact | Status |
|-------|---------|--------|--------|
| Sync file reads | [N] occurrences | [impact] | PASS/WARN |
| SQLite indexes | [details] | [impact] | PASS/WARN |
| Connection leaks | [N] unmatched | [impact] | PASS/FAIL |
| Tool count | [N] tools / [N] modules | [impact] | INFO |
```

---

## COMPLETION REPORT

```markdown
## CS PERF COMPLETE

### Performance Scorecard

| Check | Items | Issues | Worst | Status |
|-------|-------|--------|-------|--------|
| Bundle Analysis | [N] routes | [N] | [sev] | PASS/WARN/FAIL |
| Loading States | [N] pages | [N] missing | [sev] | PASS/WARN |
| Query Patterns | [N] queries | [N] issues | [sev] | PASS/WARN/FAIL |
| Edge Functions | [N] functions | [N] oversized | [sev] | PASS/WARN/FAIL |
| Image Optimization | [N] images | [N] issues | [sev] | PASS/WARN |
| MCP Server | [N] checks | [N] issues | [sev] | PASS/WARN |

### Overall: OPTIMIZED / NEEDS ATTENTION / PERFORMANCE RISK

- **OPTIMIZED**: 0 high/critical issues
- **NEEDS ATTENTION**: 1+ medium issues, 0 high/critical
- **PERFORMANCE RISK**: 1+ high/critical issues

### Top Recommendations (by impact)

| # | Area | Issue | Impact | Effort | Recommendation |
|---|------|-------|--------|--------|----------------|
| 1 | [area] | [issue] | HIGH/MED | LOW/MED/HIGH | [specific action] |
| 2 | [area] | [issue] | HIGH/MED | LOW/MED/HIGH | [specific action] |
| 3 | [area] | [issue] | HIGH/MED | LOW/MED/HIGH | [specific action] |

### Quick Wins (high impact, low effort)
- [List of easy fixes that would improve performance]
```
