---
name: massu-perf
description: "When user says 'performance audit', 'slow queries', 'bundle too large', 'page is slow', or needs to identify performance bottlenecks in queries, bundle size, or render cycles"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
disable-model-invocation: true
---
name: massu-perf

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-14, CR-5, CR-12 enforced.

# Massu Perf: Performance Audit Protocol

## Objective

Identify and fix performance bottlenecks in database queries, bundle size, rendering, and API calls with **measurable evidence**.

---

## NON-NEGOTIABLE RULES

- **Measure before optimizing** - Prove the bottleneck exists
- **Measure after optimizing** - Prove the fix worked
- **No premature optimization** - Focus on actual issues
- **Follow patterns** - Use CLAUDE.md approved approaches
- **Document benchmarks** - Show before/after metrics

---

## ZERO-GAP AUDIT LOOP

**Performance optimization does NOT complete until a SINGLE COMPLETE AUDIT finds ZERO issues.**

### The Rule

```
PERFORMANCE AUDIT LOOP:
  1. Identify bottlenecks with measurements
  2. Apply optimizations
  3. Run ALL verification checks (patterns, types, build, benchmarks)
  4. Count issues found
  5. IF issues > 0:
       - Fix ALL issues
       - Re-run ENTIRE verification from Step 3
  6. IF issues == 0:
       - OPTIMIZATION VERIFIED
```

### Completion Requirement

| Scenario | Action |
|----------|--------|
| Optimization breaks build | Fix it, re-verify ENTIRELY |
| Re-verify finds regression | Fix it, re-verify ENTIRELY |
| Re-verify finds 0 issues | **NOW** optimization complete |

**Partial verification is NOT valid. ALL checks must pass in a SINGLE run.**

---

## DOMAIN-SPECIFIC PATTERN LOADING

| Domain | Pattern File |
|--------|--------------|
| Database queries | `.claude/patterns/database-patterns.md` |
| UI rendering | `.claude/patterns/ui-patterns.md` |
| Build optimization | `.claude/patterns/build-patterns.md` |

---

## AUDIT SECTION 1: DATABASE PERFORMANCE

### 1.1 Query Analysis
```sql
-- Find slow queries (requires pg_stat_statements extension)
SELECT query, calls, total_time, mean_time
FROM pg_stat_statements
ORDER BY mean_time DESC
LIMIT 20;

-- Find queries without indexes
SELECT schemaname, tablename, seq_scan, idx_scan
FROM pg_stat_user_tables
WHERE seq_scan > idx_scan
ORDER BY seq_scan DESC;

-- Find large tables
SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC
LIMIT 20;
```

### 1.2 Index Analysis
```sql
-- Missing indexes (high seq_scan)
SELECT relname, seq_scan, idx_scan,
       CASE WHEN seq_scan + idx_scan > 0
            THEN round(100.0 * idx_scan / (seq_scan + idx_scan), 2)
            ELSE 0 END AS idx_usage_pct
FROM pg_stat_user_tables
WHERE seq_scan > 1000
ORDER BY seq_scan DESC;

-- Existing indexes
SELECT indexname, tablename, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename;

-- Unused indexes (candidates for removal)
SELECT schemaname, tablename, indexrelname, idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0 AND schemaname = 'public';
```

### 1.3 Query Pattern Check
```bash
# Find N+1 query patterns (loops with queries inside)
grep -rn "for.*await.*db\|forEach.*await.*db" src/

# Find missing WHERE clauses (full table scans)
grep -rn "findMany()\|findMany({})" src/

# Find large LIMIT values
grep -rn "take:\s*[0-9]\{3,\}" src/
```

### 1.4 Database Performance Matrix
```markdown
### Database Performance Audit

| Query/Table | Avg Time | Calls | Index Used | Status |
|-------------|----------|-------|------------|--------|
| [query] | Xms | N | YES/NO | OK/SLOW |
```

---

## AUDIT SECTION 2: BUNDLE SIZE

### 2.1 Bundle Analysis
```bash
# Analyze bundle size
npm run build 2>&1 | grep -A 50 "Route\|Size"

# Check for large dependencies
npm ls --depth=0 | head -30

# Find heavy imports
grep -rn "import.*from" src/ | grep -v node_modules | cut -d: -f2 | sort | uniq -c | sort -rn | head -20
```

### 2.2 Dynamic Import Check
```bash
# Find dynamic imports (good)
grep -rn "await import\|React.lazy\|dynamic(" src/ | grep -v node_modules | wc -l

# Find static heavy imports that should be dynamic
grep -rn "import.*jsdom\|import.*moment\|import.*lodash" src/ | grep -v "await import"
# These should use dynamic imports
```

### 2.3 Tree Shaking Issues
```bash
# Find namespace imports (blocks tree shaking)
grep -rn "import \* as" src/ | grep -v node_modules

# Find barrel imports from large packages
grep -rn "from '@mui\|from 'lodash'\|from 'date-fns'" src/ | grep -v node_modules
```

### 2.4 Bundle Size Matrix
```markdown
### Bundle Size Audit

| Route/Page | Size | First Load | Status |
|------------|------|------------|--------|
| / | X kB | X kB | OK/LARGE |
| /dashboard | X kB | X kB | OK/LARGE |
```

---

## AUDIT SECTION 3: RENDERING PERFORMANCE

### 3.1 Re-render Analysis
```bash
# Find missing useMemo
grep -rn "const.*=.*filter\|const.*=.*map\|const.*=.*reduce" src/components/ | grep -v "useMemo" | head -20

# Find missing useCallback
grep -rn "const.*=.*=>" src/components/ | grep "onClick\|onChange\|onSubmit" | grep -v "useCallback" | head -20

# Find inline object/array creation (causes re-renders)
grep -rn "style={\s*{" src/ | grep -v node_modules | head -10
grep -rn "className={\s*\[" src/ | grep -v node_modules | head -10
```

### 3.2 Component Optimization
```bash
# Find large components (complexity indicator)
find src/components -name "*.tsx" -exec wc -l {} \; | sort -rn | head -20

# Find components without memo
grep -rn "export default function\|export function" src/components/ | grep -v "memo(" | head -20

# Find expensive computations in render
grep -rn "\.filter(\|\.map(\|\.reduce(" src/components/ | grep -v node_modules | wc -l
```

### 3.3 List Optimization
```bash
# Find lists without keys
grep -rn "\.map(" src/components/ | grep -v "key=" | head -20

# Find virtualization usage (good for long lists)
grep -rn "VirtualList\|useVirtualizer\|react-window\|react-virtual" src/

# Find potentially long lists
grep -rn "\.map(" src/components/ | head -30
```

### 3.4 Rendering Matrix
```markdown
### Rendering Performance Audit

| Component | Lines | useMemo | useCallback | memo | Status |
|-----------|-------|---------|-------------|------|--------|
| [comp] | N | YES/NO | YES/NO | YES/NO | OK/REVIEW |
```

---

## AUDIT SECTION 4: API PERFORMANCE

### 4.1 API Call Analysis
```bash
# Find all API calls
grep -rn "useQuery\|useMutation\|api\." src/components/ src/app/ | grep -v node_modules | wc -l

# Find refetch on mount (potential over-fetching)
grep -rn "refetchOnMount\|refetchOnWindowFocus" src/ | grep -v "false"

# Find stale time configuration
grep -rn "staleTime\|cacheTime\|gcTime" src/

# Find parallel queries (good)
grep -rn "useQueries" src/ | grep -v node_modules
```

### 4.2 Query Deduplication
```bash
# Find same query called multiple times
grep -rn "useQuery\|api\.[a-z]*\.[a-z]*" src/ | grep -v node_modules | sort | uniq -c | sort -rn | head -10
```

### 4.3 API Performance Matrix
```markdown
### API Performance Audit

| Endpoint | Calls/Page | Cached | Stale Time | Status |
|----------|------------|--------|------------|--------|
| [endpoint] | N | YES/NO | Xs | OK/REVIEW |
```

---

## AUDIT SECTION 5: NETWORK OPTIMIZATION

### 5.1 Request Analysis
```bash
# Find fetch calls
grep -rn "fetch(\|axios\." src/ | grep -v node_modules | grep -v "trpc"

# Find image optimization
grep -rn "<Image\|<img" src/ | grep -v node_modules | wc -l
grep -rn "next/image" src/ | grep -v node_modules | wc -l

# Find preloading
grep -rn "prefetch\|preload" src/ | grep -v node_modules
```

### 5.2 Caching Strategy
```bash
# Check cache headers configuration
grep -rn "Cache-Control\|revalidate\|s-maxage" src/ next.config.*

# Check static generation
grep -rn "getStaticProps\|getStaticPaths\|generateStaticParams" src/
```

---

## OPTIMIZATION PATTERNS

### Database Optimization
```typescript
// BAD: N+1 query
for (const order of orders) {
  const customer = await db.user_profiles.findUnique({ where: { id: order.customer_id } });
}

// GOOD: Batch query
const customerIds = [...new Set(orders.map(o => o.customer_id).filter(Boolean))];
const customers = await db.user_profiles.findMany({ where: { id: { in: customerIds } } });
const customerMap = new Map(customers.map(c => [c.id, c]));
```

### Component Optimization
```typescript
// BAD: Re-creates on every render
const filteredItems = items.filter(i => i.active);

// GOOD: Memoized
const filteredItems = useMemo(() => items.filter(i => i.active), [items]);

// BAD: New function on every render
<Button onClick={() => handleClick(id)} />

// GOOD: Stable reference
const handleButtonClick = useCallback(() => handleClick(id), [id]);
<Button onClick={handleButtonClick} />
```

### Import Optimization
```typescript
// BAD: Static heavy import
import { JSDOM } from 'jsdom';

// GOOD: Dynamic import
const { JSDOM } = await import('jsdom');

// BAD: Namespace import
import * as lodash from 'lodash';

// GOOD: Named import (tree shakeable)
import { debounce, throttle } from 'lodash';
```

---

## PERFORMANCE REPORT FORMAT

```markdown
## MASSU PERF AUDIT REPORT

### Summary
- **Date**: [timestamp]
- **Scope**: Full performance audit
- **Critical Issues**: [N]
- **Optimizations Identified**: [N]

### Database Performance
| Issue | Impact | Fix | Priority |
|-------|--------|-----|----------|
| [issue] | [impact] | [fix] | P0/P1/P2 |

### Bundle Size
| Route | Current | Target | Action |
|-------|---------|--------|--------|
| [route] | X kB | Y kB | [action] |

### Rendering
| Component | Issue | Fix | Priority |
|-----------|-------|-----|----------|
| [comp] | Missing memo | Add React.memo | P2 |

### API
| Endpoint | Issue | Fix | Priority |
|----------|-------|-----|----------|
| [endpoint] | Over-fetching | Add staleTime | P1 |

### Recommendations
1. [Recommendation 1]
2. [Recommendation 2]

**Performance Score: [X/100]**
```

---

## SESSION STATE UPDATE

After audit, update `session-state/CURRENT.md`:

```markdown
## PERF AUDIT SESSION

### Audit
- **Date**: [timestamp]
- **Scope**: [DB/Bundle/Rendering/API/All]

### Findings
- Database: [N] issues
- Bundle: [N] issues
- Rendering: [N] issues
- API: [N] issues

### Optimizations Applied
[List or "None - audit only"]

### Metrics
| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| [metric] | X | Y | Z% |
```

---

## START NOW

1. Run Section 1: Database Performance
2. Run Section 2: Bundle Size Analysis
3. Run Section 3: Rendering Performance
4. Run Section 4: API Performance
5. Run Section 5: Network Optimization
6. Identify top issues by impact
7. Prioritize optimizations
8. Produce performance report
9. Update session state

**Remember: Measure -> Optimize -> Measure. No guessing.**
