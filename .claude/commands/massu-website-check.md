---
name: massu-website-check
description: Website-specific verification (TypeScript, Next.js build, tests, security, Supabase)
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---
name: massu-website-check

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# CS Website Check: Website Verification Gate

## Objective

Run comprehensive verification checks specific to the website (Next.js + Supabase). Covers type safety, build, tests, environment variables, client/server boundaries, Supabase migration ordering, and security hardening.

---

## NON-NEGOTIABLE RULES

- Run ALL gates even if early ones fail
- Document ALL findings with file:line references
- Security findings are ALWAYS reported
- Do NOT modify any files (report only, unless combined with /massu-loop)

---

## GATE 1: TypeScript Check

```bash
cd website && npx tsc --noEmit 2>&1
```

| Metric | Value | Status |
|--------|-------|--------|
| Type errors | [N] | PASS/FAIL |

---

## GATE 2: Next.js Build

```bash
cd website && npm run build 2>&1
```

| Metric | Value | Status |
|--------|-------|--------|
| Build | Exit [N] | PASS/FAIL |
| Build warnings | [N] | INFO |

---

## GATE 3: Website Tests

```bash
cd website && npm test 2>&1 || echo "No test script configured"
```

| Metric | Value | Status |
|--------|-------|--------|
| Tests | [N] passed, [N] failed | PASS/FAIL/N/A |

---

## GATE 4: Environment Variable Audit

```bash
# Find all env var references in client-side code
grep -rn 'process\.env\.' website/src/ --include="*.ts" --include="*.tsx" \
  | grep -v 'node_modules'

# Check for secrets exposed via NEXT_PUBLIC_
grep -rn 'NEXT_PUBLIC_' website/src/ --include="*.ts" --include="*.tsx" \
  | grep -v 'node_modules'

# Verify .env files are gitignored
cat website/.gitignore 2>/dev/null | grep '.env' || echo "WARNING: .env not in .gitignore"
```

### Env Var Classification

| Variable | Prefix | Client-Exposed? | Contains Secret? | Status |
|----------|--------|-----------------|-------------------|--------|
| [var] | NEXT_PUBLIC_ | YES | YES/NO | PASS/FAIL |

**FAIL if**: Any `NEXT_PUBLIC_` variable contains secrets (API keys, DB passwords, etc.)

---

## GATE 5: Client/Server Boundary Check

```bash
# Find 'use client' directives
grep -rn "'use client'" website/src/ --include="*.tsx" --include="*.ts" | wc -l

# Find 'use server' directives
grep -rn "'use server'" website/src/ --include="*.tsx" --include="*.ts" | wc -l

# Check for server-only imports in client components
# (e.g., importing Supabase admin client in 'use client' files)
grep -rn "'use client'" website/src/ --include="*.tsx" -l | while read f; do
  if grep -q 'createClient.*service_role\|supabaseAdmin' "$f" 2>/dev/null; then
    echo "VIOLATION: $f uses server-only imports in client component"
  fi
done
```

| Metric | Value |
|--------|-------|
| Client components | [N] |
| Server components | [N] |
| Boundary violations | [N] |

---

## GATE 6: Supabase Migration Ordering

```bash
# Check migration files are sequentially numbered
ls -1 website/supabase/migrations/ 2>/dev/null | sort

# Verify no gaps in numbering
ls -1 website/supabase/migrations/ 2>/dev/null | grep -oP '^\d+' | sort -n
```

| Metric | Value | Status |
|--------|-------|--------|
| Migrations | [N] files | PASS/FAIL |
| Sequential | YES/NO | PASS/FAIL |

---

## GATE 7: Security Hardening Check

```bash
# Check for dangerouslySetInnerHTML
grep -rn 'dangerouslySetInnerHTML' website/src/ --include="*.tsx" --include="*.ts"

# Check for javascript: URLs
grep -rn 'javascript:' website/src/ --include="*.tsx" --include="*.ts"

# Check for eval()
grep -rn '\beval(' website/src/ --include="*.tsx" --include="*.ts"

# Check CSP headers
grep -rn 'Content-Security-Policy\|contentSecurityPolicy' website/ --include="*.ts" --include="*.tsx" --include="*.js"

# Check for unvalidated redirects
grep -rn 'redirect\|router\.push\|router\.replace' website/src/ --include="*.tsx" --include="*.ts" | head -20
```

```markdown
### Security Findings

| File:Line | Type | Severity | Details |
|-----------|------|----------|---------|
| [loc] | [type] | [sev] | [details] |
```

---

## GATE 8: Supabase RLS Policy Check

```bash
# List all tables and their RLS status from migration files
grep -n 'CREATE TABLE\|ALTER TABLE.*ENABLE ROW LEVEL SECURITY\|CREATE POLICY' \
  website/supabase/migrations/*.sql 2>/dev/null
```

| Table | RLS Enabled | Policies | Status |
|-------|-------------|----------|--------|
| [table] | YES/NO | [N] | PASS/FAIL |

**FAIL if**: Any table lacks RLS or has fewer than expected policies.

---

## COMPLETION REPORT

```markdown
## CS WEBSITE CHECK COMPLETE

### Gate Summary
| Gate | Check | Status |
|------|-------|--------|
| 1 | TypeScript | PASS/FAIL |
| 2 | Next.js Build | PASS/FAIL |
| 3 | Tests | PASS/FAIL/N/A |
| 4 | Env Variables | PASS/FAIL |
| 5 | Client/Server Boundary | PASS/FAIL |
| 6 | Migration Ordering | PASS/FAIL |
| 7 | Security Hardening | PASS/FAIL |
| 8 | Supabase RLS | PASS/FAIL |

### Overall: PASS / FAIL

### Findings Requiring Action
1. [Critical findings]
2. [High findings]
3. [Medium findings]
```
