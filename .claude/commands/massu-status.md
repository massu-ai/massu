---
name: massu-status
description: Read-only project health dashboard with 14 health checks
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# CS Status: Project Health Dashboard

## Objective

Provide a comprehensive READ-ONLY snapshot of the project's health across all dimensions. No files are modified. This is purely diagnostic.

---

## NON-NEGOTIABLE RULES

- Do NOT modify any files
- Do NOT fix any issues found
- Report ALL findings with clear status indicators
- Run ALL checks even if early ones fail

---

## HEALTH CHECKS

### 1. Test Suite Health

```bash
npm test 2>&1
```

| Metric | Value | Status |
|--------|-------|--------|
| Total tests | [N] | - |
| Passing | [N] | PASS/FAIL |
| Failing | [N] | - |
| Skipped | [N] | - |

### 2. Type Safety

```bash
cd packages/core && npx tsc --noEmit 2>&1
```

| Metric | Value | Status |
|--------|-------|--------|
| Type errors | [N] | PASS/FAIL |

### 3. Hook Compilation

```bash
cd packages/core && npm run build:hooks 2>&1
```

| Metric | Value | Status |
|--------|-------|--------|
| Hook build | Exit [N] | PASS/FAIL |
| Hooks compiled | [N] | - |

### 4. Pattern Scanner

```bash
bash scripts/massu-pattern-scanner.sh 2>&1
```

| Metric | Value | Status |
|--------|-------|--------|
| Violations | [N] | PASS/FAIL |

### 5. Dependency Health

```bash
npm audit --audit-level=high 2>&1 || true
npm outdated 2>&1 || true
```

| Metric | Value | Status |
|--------|-------|--------|
| High/Critical vulns | [N] | PASS/FAIL |
| Outdated packages | [N] | INFO |

### 6. Git State

```bash
git status --short
git log -5 --oneline
git branch -v
```

| Metric | Value |
|--------|-------|
| Branch | [name] |
| Clean working tree | YES/NO |
| Uncommitted changes | [N] files |
| Last commit | [hash] [message] |
| Ahead/behind origin | [N]/[N] |

### 7. Tool Inventory

```bash
# Count registered tools
grep -c "name:" packages/core/src/tools.ts

# Count tool modules (3-function pattern)
grep -c "isTool\b" packages/core/src/tools.ts

# Count tool modules (legacy pattern)
grep -c "startsWith" packages/core/src/tools.ts
```

| Metric | Value |
|--------|-------|
| Total MCP tools | [N] |
| Tool modules (3-func) | [N] |
| Tool modules (legacy) | [N] |

### 8. Code Metrics

```bash
# Source line counts
find packages/core/src -name "*.ts" -not -path "*/__tests__/*" -not -path "*/node_modules/*" | xargs wc -l | tail -1
find packages/core/src/__tests__ -name "*.test.ts" | xargs wc -l | tail -1

# File counts
find packages/core/src -name "*.ts" -not -path "*/__tests__/*" -not -path "*/node_modules/*" | wc -l
find packages/core/src/__tests__ -name "*.test.ts" | wc -l
```

| Metric | Value |
|--------|-------|
| Source files | [N] |
| Source LOC | [N] |
| Test files | [N] |
| Test LOC | [N] |
| Test:Source ratio | [X]:1 |

### 9. Website Health (if website/ exists)

```bash
if [ -d "website" ]; then
  cd website && npx tsc --noEmit 2>&1 | tail -5
  echo "---"
  ls -la src/app/ 2>/dev/null | wc -l
fi
```

| Metric | Value | Status |
|--------|-------|--------|
| Website type check | [N] errors | PASS/FAIL/N/A |
| Website pages | [N] | - |

### 10. Test Coverage Gaps

```bash
# List source modules without test files
for f in packages/core/src/*.ts; do
  base=$(basename "$f" .ts)
  test_file="packages/core/src/__tests__/${base}.test.ts"
  if [ ! -f "$test_file" ]; then
    echo "MISSING: $base"
  fi
done
```

| Metric | Value | Status |
|--------|-------|--------|
| Modules with tests | [N] | - |
| Modules without tests | [N] | - |
| Coverage percentage | [N]% | PASS (>=80%) / WARN (50-79%) / FAIL (<50%) |

### 11. Bundle Size (if website/ exists)

```bash
if [ -d "website/.next" ]; then
  cd website && npx next build 2>&1 | grep "Route"
fi
```

| Metric | Value | Status |
|--------|-------|--------|
| Routes < 150KB | [N] | - |
| Routes 150-250KB | [N] | WARN |
| Routes > 250KB | [N] | FAIL |
| Status | - | PASS/WARN/FAIL |

### 12. Migration Health (if website/supabase/migrations/ exists)

```bash
if [ -d "website/supabase/migrations" ]; then
  ls website/supabase/migrations/*.sql 2>/dev/null | wc -l
  # Check sequential numbering
  # Check RLS coverage for each CREATE TABLE
fi
```

| Metric | Value | Status |
|--------|-------|--------|
| Total migrations | [N] | - |
| Sequential numbering | YES/NO | PASS/FAIL |
| Tables with RLS | [N]/[N] | - |
| RLS coverage | [N]% | PASS (100%) / FAIL (<100%) |

### 13. API Endpoint Inventory (if website/src/app/api/ exists)

```bash
if [ -d "website/src/app/api" ]; then
  find website/src/app/api -name "route.ts" | while read f; do
    has_auth=$(grep -l 'createServerSupabaseClient\|authenticateApiKey' "$f" 2>/dev/null)
    if [ -z "$has_auth" ]; then
      echo "NO AUTH: $f"
    fi
  done
fi
```

| Metric | Value | Status |
|--------|-------|--------|
| Total API endpoints | [N] | - |
| Endpoints with auth | [N] | - |
| Auth coverage | [N]% | PASS (100%) / WARN (>=80%) / FAIL (<80%) |

### 14. Edge Function Inventory (if website/supabase/functions/ exists)

```bash
if [ -d "website/supabase/functions" ]; then
  for d in website/supabase/functions/*/; do
    name=$(basename "$d")
    size=$(wc -c < "$d/index.ts" 2>/dev/null || echo "N/A")
    echo "$name: $size bytes"
  done
fi
```

| Metric | Value | Status |
|--------|-------|--------|
| Total edge functions | [N] | INFO |
| Largest function size | [N] bytes | INFO |

---

## HEALTH SUMMARY

```markdown
## PROJECT HEALTH DASHBOARD

### Overall Status: HEALTHY / DEGRADED / UNHEALTHY

| # | Dimension | Status | Details |
|---|-----------|--------|---------|
| 1 | Tests | PASS/FAIL | [N]/[N] passing |
| 2 | Types | PASS/FAIL | [N] errors |
| 3 | Hooks | PASS/FAIL | [N] compiled |
| 4 | Patterns | PASS/FAIL | [N] violations |
| 5 | Security | PASS/FAIL | [N] high/critical vulns |
| 6 | Git | CLEAN/DIRTY | [details] |
| 7 | Tool Inventory | INFO | [N] tools |
| 8 | Code Metrics | INFO | [N] LOC |
| 9 | Website | PASS/FAIL/N/A | [N] errors |
| 10 | Test Coverage | PASS/WARN/FAIL | [N]% modules covered |
| 11 | Bundle Size | PASS/WARN/FAIL/N/A | [N] routes over threshold |
| 12 | Migration Health | PASS/FAIL/N/A | [N]% RLS coverage |
| 13 | API Endpoints | PASS/WARN/FAIL/N/A | [N]% auth coverage |
| 14 | Edge Functions | INFO/N/A | [N] functions |

### Classification
- **HEALTHY**: All checks pass, clean git state
- **DEGRADED**: Minor issues (outdated deps, warnings)
- **UNHEALTHY**: Failing tests, type errors, or security vulns

### Quick Fix Commands (if degraded/unhealthy)
- Tests failing: `npm test` to see failures, then fix
- Type errors: `cd packages/core && npx tsc --noEmit` for details
- Pattern violations: `bash scripts/massu-pattern-scanner.sh` for details
- Vulnerabilities: `npm audit` for details, `/massu-audit-deps` for full audit
```
