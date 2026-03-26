---
name: massu-security
description: "When user says 'security audit', 'check security', 'RLS audit', 'XSS check', or needs a focused security review covering auth, secrets, injection, and OWASP top 10"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*), mcp__supabase__DEV__*, mcp__supabase__NEW_PROD__*, mcp__supabase__OLD_PROD__*
disable-model-invocation: true
---
name: massu-security

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-14, CR-5, CR-12 enforced.

# Massu Security: Comprehensive Security Audit

## Objective

Execute a thorough security audit covering authentication, authorization, data protection, and common vulnerabilities. **Zero tolerance for security gaps.**

---

## NON-NEGOTIABLE RULES

- **No secrets in code** - Environment variables only
- **No secrets in git** - Check every commit
- **Protected mutations** - ALL mutations use protectedProcedure
- **RLS on all tables** - Policies AND grants required
- **Input validation** - Zod schemas on all inputs
- **No prototype pollution** - Never use `prototype` as object key
- **Proof required** - Show grep/query output as evidence
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - If ANY issue is discovered during security audit - whether from current changes OR pre-existing - fix it immediately. "Not in scope" and "pre-existing" are NEVER valid reasons to skip a fix. When fixing a bug, search entire codebase for same pattern and fix ALL instances.

---

## ZERO-GAP AUDIT LOOP

**This security audit does NOT complete until a SINGLE COMPLETE AUDIT finds ZERO issues.**

### The Rule

```
SECURITY AUDIT LOOP:
  1. Run ALL security checks (all sections)
  2. Count total security issues found
  3. IF issues > 0:
       - Fix ALL issues
       - Re-run ENTIRE audit from Step 1
  4. IF issues == 0:
       - SECURITY CERTIFIED
```

### Completion Requirement

| Scenario | Action |
|----------|--------|
| Audit finds 3 vulnerabilities | Fix all 3, re-run ENTIRE audit |
| Re-audit finds 1 issue | Fix it, re-run ENTIRE audit |
| Re-audit finds 0 issues | **NOW** security passes |

**Partial re-checks are NOT valid. The ENTIRE security audit must pass in a SINGLE run.**

---

## SECURITY SEVERITY LEVELS

| Level | Definition | Action |
|-------|------------|--------|
| **CRITICAL** | Immediate exploitation risk | HARD STOP - Fix immediately |
| **HIGH** | Significant vulnerability | Block deployment until fixed |
| **MEDIUM** | Potential weakness | Fix before next release |
| **LOW** | Best practice violation | Track for future fix |

---

## SUPABASE ENVIRONMENTS

| Environment | Project ID | MCP Tool Prefix |
|-------------|------------|-----------------|
| DEV | `gwqkbjymbarkufwvdmar` | `mcp__supabase__DEV__` |
| OLD PROD | `hwaxogapihsqleyzpqtj` | `mcp__supabase__OLD_PROD__` |
| NEW PROD | `cnfxxvrhhvjefyvpoqlq` | `mcp__supabase__NEW_PROD__` |

---

## DOMAIN-SPECIFIC PATTERN LOADING

| Domain | Pattern File | Load When |
|--------|--------------|-----------|
| Auth vulnerabilities | `.claude/patterns/auth-patterns.md` | Always for security audit |
| Database security | `.claude/patterns/database-patterns.md` | RLS/grants audit |
| Build security | `.claude/patterns/build-patterns.md` | Dependency vulnerabilities |

---

## AUDIT SECTION 1: SECRETS & CREDENTIALS

### 1.1 Secrets in Repository
```bash
# Check for .env files in git history
git log --all --full-history -- "*.env*" | head -20

# Check for staged secret files
git diff --cached --name-only | grep -E '\.(env|pem|key|secret|credentials)'
# Expected: 0 files

# Check .gitignore has proper patterns
grep -n "\.env" .gitignore
grep -n "\.pem" .gitignore
grep -n "\.key" .gitignore
grep -n "secret" .gitignore

# Find any .env files (should only be .env.example)
find . -name ".env*" -not -name ".env.example" -not -path "./node_modules/*" 2>/dev/null
# Expected: 0 files (or only local untracked)
```

### 1.2 Hardcoded Credentials
```bash
# API keys in code
grep -rn "sk-\|pk_\|api_key.*=.*['\"]" --include="*.ts" --include="*.tsx" src/ | grep -v "process.env" | wc -l
# Expected: 0

# Password patterns
grep -rn "password.*=.*['\"]" --include="*.ts" --include="*.tsx" src/ | grep -v "process.env\|type\|schema\|zod" | wc -l
# Expected: 0

# Connection strings
grep -rn "postgresql://\|mysql://\|mongodb://" --include="*.ts" --include="*.tsx" src/ | grep -v "process.env" | wc -l
# Expected: 0

# AWS/GCP/Azure credentials
grep -rn "AKIA\|GOOG\|AZURE" --include="*.ts" --include="*.tsx" src/ | wc -l
# Expected: 0

# JWT secrets
grep -rn "jwt.*secret\|JWT.*SECRET" --include="*.ts" --include="*.tsx" src/ | grep -v "process.env" | wc -l
# Expected: 0
```

### 1.3 Environment Variable Audit
```bash
# List all env vars used
grep -rn "process.env\." src/ | grep -v node_modules | grep -oP 'process\.env\.\w+' | sort -u

# Verify all are documented
cat .env.example 2>/dev/null | grep -v "^#" | cut -d= -f1 | sort

# Check for NEXT_PUBLIC_ exposure (should be intentional)
grep -rn "NEXT_PUBLIC_" src/ | grep -v node_modules | grep -oP 'NEXT_PUBLIC_\w+' | sort -u
```

**Secrets Audit Matrix:**
```markdown
| Check | Expected | Actual | Status |
|-------|----------|--------|--------|
| .env files in git | 0 | | PASS/FAIL |
| Hardcoded API keys | 0 | | PASS/FAIL |
| Hardcoded passwords | 0 | | PASS/FAIL |
| Connection strings | 0 | | PASS/FAIL |
| .gitignore patterns | Present | | PASS/FAIL |
```

---

## AUDIT SECTION 2: AUTHENTICATION

### 2.1 Session Management
```bash
# Check session configuration
grep -rn "session\|Session" src/lib/auth/ src/server/auth/ 2>/dev/null | head -20

# Check for session token exposure
grep -rn "session.*token\|accessToken\|refreshToken" src/ | grep -v node_modules | grep -v "\.d\.ts"

# Verify secure cookie settings
grep -rn "httpOnly\|secure\|sameSite" src/ | grep -v node_modules
```

### 2.2 Authentication Flow
```bash
# Find all auth-related code
find src -name "*auth*" -o -name "*login*" -o -name "*session*" 2>/dev/null | grep -v node_modules

# Check for proper auth guards
grep -rn "getServerSession\|useSession\|protectedProcedure" src/app/ src/server/ | head -30

# Verify middleware auth checks
grep -A 30 "middleware" src/middleware.ts 2>/dev/null
```

### 2.3 Protected Routes
```bash
# Check middleware protected routes
grep -A 20 "protectedRoutes\|matcher" src/middleware.ts

# Find pages without auth checks (potential issues)
find src/app -name "page.tsx" -exec grep -L "getServerSession\|useSession\|redirect" {} \;
```

---

## AUDIT SECTION 3: AUTHORIZATION (tRPC)

### 3.1 Procedure Protection (CRITICAL)
```bash
# Find ALL mutations
grep -rn "\.mutation" src/server/api/routers/ | wc -l

# Find public mutations (SECURITY VIOLATION)
grep -rn "publicProcedure\.mutation" src/server/api/routers/
# Expected: 0 matches - ALL mutations must be protected

# Find protected mutations (correct)
grep -rn "protectedProcedure\.mutation" src/server/api/routers/ | wc -l

# Verify ratio
echo "All mutations should use protectedProcedure"
```

### 3.2 Input Validation
```bash
# Find procedures without input validation
grep -rn "protectedProcedure\|publicProcedure" src/server/api/routers/ | grep -v "\.input("
# Review these - may be acceptable for queries with no params

# Find all input schemas
grep -rn "\.input(z\." src/server/api/routers/ | wc -l

# Check for raw input usage (bypassing validation)
grep -rn "input\." src/server/api/routers/ | grep -v "input:" | head -20
```

### 3.3 User Context Verification
```bash
# Verify ctx.user.id usage (not client-provided)
grep -rn "ctx\.user\.id\|ctx\.session\.user" src/server/api/routers/ | wc -l

# Check for user ID from input (potential vulnerability)
grep -rn "input\.userId\|input\.user_id" src/server/api/routers/
# Review these - should use ctx.user.id instead
```

**Authorization Audit Matrix:**
```markdown
| Check | Expected | Actual | Status |
|-------|----------|--------|--------|
| publicProcedure.mutation | 0 | | PASS/FAIL |
| All mutations protected | 100% | | PASS/FAIL |
| Input validation | All procedures | | PASS/FAIL |
| ctx.user.id usage | Yes | | PASS/FAIL |
```

---

## AUDIT SECTION 4: DATABASE SECURITY (RLS)

### 4.1 RLS Status Check
For EACH user-facing table in ALL 3 environments:

```sql
-- Check RLS enabled
SELECT tablename, rowsecurity
FROM pg_tables t
JOIN pg_class c ON c.relname = t.tablename
WHERE schemaname = 'public' AND relrowsecurity = true;

-- Tables WITHOUT RLS (potential issue)
SELECT tablename
FROM pg_tables t
JOIN pg_class c ON c.relname = t.tablename
WHERE schemaname = 'public' AND relrowsecurity = false;
```

### 4.2 Policy Completeness
```sql
-- All policies
SELECT tablename, polname, polcmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, polname;

-- Tables with policies
SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public';

-- Check for service_role policies (CRITICAL)
SELECT tablename, polname
FROM pg_policies
WHERE polname LIKE '%service%' OR polroles::text LIKE '%service_role%';
```

### 4.3 Grants Verification
```sql
-- service_role grants (MUST exist)
SELECT table_name, privilege_type
FROM information_schema.table_privileges
WHERE grantee = 'service_role' AND table_schema = 'public';

-- authenticated grants
SELECT table_name, privilege_type
FROM information_schema.table_privileges
WHERE grantee = 'authenticated' AND table_schema = 'public';

-- anon grants (should be minimal)
SELECT table_name, privilege_type
FROM information_schema.table_privileges
WHERE grantee = 'anon' AND table_schema = 'public';
```

**RLS Audit Matrix:**
```markdown
| Table | RLS Enabled | Policies | service_role Grant | Status |
|-------|-------------|----------|-------------------|--------|
| [table1] | YES/NO | N | YES/NO | PASS/FAIL |
| [table2] | YES/NO | N | YES/NO | PASS/FAIL |
```

---

## AUDIT SECTION 5: INJECTION VULNERABILITIES

### 5.1 SQL Injection
```bash
# Find raw SQL (potential injection)
grep -rn "\.raw\|\.unsafe\|\$queryRaw\|sql\`" src/server/ | grep -v node_modules
# Review each - ensure no user input concatenation

# Find string concatenation in queries
grep -rn "\${.*}" src/server/ | grep -i "select\|insert\|update\|delete" | head -20
# Review for SQL injection

# Check for parameterized queries (correct)
grep -rn "\\$1\|\\$2\|\\?" src/server/ | grep -i "sql" | head -10
```

### 5.2 XSS Prevention
```bash
# Find dangerouslySetInnerHTML
grep -rn "dangerouslySetInnerHTML" src/
# Review each - ensure content is sanitized

# Find innerHTML assignments
grep -rn "\.innerHTML\s*=" src/ | grep -v node_modules

# Check for URL parameters in renders
grep -rn "searchParams\|query\." src/app/ | grep -v "\.d\.ts"
```

### 5.3 Prototype Pollution (CLAUDE.md Critical)
```bash
# Check for prototype as object key
grep -rn "prototype:" src/ | grep -v "Object.prototype" | wc -l
# Expected: 0 (CRITICAL violation)

# Check for __proto__
grep -rn "__proto__" src/ | wc -l
# Expected: 0
```

### 5.4 Command Injection
```bash
# Find exec/spawn calls
grep -rn "exec(\|spawn(\|execSync\|spawnSync" src/ | grep -v node_modules

# Find eval usage
grep -rn "eval(\|new Function(" src/ | grep -v node_modules
# Expected: 0
```

---

## AUDIT SECTION 6: DATA EXPOSURE

### 6.1 Sensitive Data Logging
```bash
# Find console.log with potential sensitive data
grep -rn "console\.log.*password\|console\.log.*token\|console\.log.*secret" src/
# Expected: 0

# Find error logging with full objects
grep -rn "console\.error.*error\)" src/ | head -20
# Review - should not expose stack traces in production
```

### 6.2 API Response Exposure
```bash
# Check for password fields in returns
grep -rn "return.*password\|password.*:" src/server/api/routers/ | grep -v "schema\|zod\|input"

# Check for sensitive fields in types
grep -rn "password\|secret\|token" src/types/ src/server/api/
```

### 6.3 Client-Side Exposure
```bash
# Check for server imports in client
grep -rn "from.*@/lib/db\|from.*prisma" src/app/ src/components/ | grep -v "server"
# Expected: 0 (causes PrismaClient to bundle)

# NEXT_PUBLIC exposure check
grep -rn "NEXT_PUBLIC_" src/ | grep -v node_modules | grep -oP 'NEXT_PUBLIC_\w+' | sort -u
# Review - only public-safe values should be exposed
```

---

## AUDIT SECTION 7: ADDITIONAL CHECKS

### 7.1 CORS Configuration
```bash
# Find CORS settings
grep -rn "cors\|CORS\|Access-Control" src/ next.config.* | grep -v node_modules
```

### 7.2 Rate Limiting
```bash
# Check for rate limiting
grep -rn "rateLimit\|rateLimiter\|throttle" src/
```

### 7.3 HTTPS Enforcement
```bash
# Check for HTTP URLs (should be HTTPS)
grep -rn "http://" src/ | grep -v "localhost\|127.0.0.1\|http://\*" | grep -v node_modules
```

### 7.4 Dependency Vulnerabilities
```bash
# Run npm audit
npm audit --production

# Check for critical vulnerabilities
npm audit --production --json | grep -i "critical\|high"
```

---

## SECURITY REPORT FORMAT

```markdown
## MASSU SECURITY AUDIT REPORT

### Audit Summary
- **Date**: [timestamp]
- **Scope**: Full security audit
- **Critical Issues**: [N]
- **High Issues**: [N]
- **Medium Issues**: [N]
- **Low Issues**: [N]

---

### Section 1: Secrets & Credentials
| Check | Result | Status |
|-------|--------|--------|
| Secrets in git | 0 files | PASS |
| Hardcoded credentials | 0 matches | PASS |
| .gitignore patterns | Complete | PASS |

### Section 2: Authentication
| Check | Result | Status |
|-------|--------|--------|
| Session security | [details] | PASS/FAIL |
| Auth guards | Present | PASS |
| Protected routes | [N] routes | PASS |

### Section 3: Authorization (tRPC)
| Check | Result | Status |
|-------|--------|--------|
| publicProcedure.mutation | 0 | PASS |
| Input validation | 100% | PASS |
| ctx.user.id usage | Yes | PASS |

### Section 4: Database Security (RLS)
| Environment | Tables with RLS | Policies | service_role Grants |
|-------------|-----------------|----------|---------------------|
| DEV | N/N | N | YES |
| OLD PROD | N/N | N | YES |
| NEW PROD | N/N | N | YES |

### Section 5: Injection Prevention
| Check | Result | Status |
|-------|--------|--------|
| SQL injection risks | 0 | PASS |
| XSS risks | 0 | PASS |
| Prototype pollution | 0 | PASS |
| Command injection | 0 | PASS |

### Section 6: Data Exposure
| Check | Result | Status |
|-------|--------|--------|
| Sensitive logging | 0 | PASS |
| API response exposure | 0 | PASS |
| Client-side leaks | 0 | PASS |

### Section 7: Additional
| Check | Result | Status |
|-------|--------|--------|
| npm audit (critical/high) | 0 | PASS |
| HTTPS enforcement | Yes | PASS |

---

### Issues Found

#### CRITICAL
[List or "None"]

#### HIGH
[List or "None"]

#### MEDIUM
[List or "None"]

#### LOW
[List or "None"]

---

### Remediation Plan
| Issue | Fix | Priority | Assignee |
|-------|-----|----------|----------|
| [issue] | [fix] | [P0/P1/P2] | [who] |

---

**SECURITY AUDIT: PASSED / FAILED**
**Deployment Allowed: YES / NO**
```

---

## SESSION STATE UPDATE

After audit, update `session-state/CURRENT.md`:

```markdown
## SECURITY AUDIT SESSION

### Audit
- **Date**: [timestamp]
- **Type**: Full security audit
- **Result**: PASSED / FAILED

### Findings
- Critical: [N]
- High: [N]
- Medium: [N]
- Low: [N]

### Fixes Applied
[List fixes if any]

### Deployment Status
[Cleared / Blocked]
```

---

## START NOW

1. Run Section 1: Secrets & Credentials
2. Run Section 2: Authentication
3. Run Section 3: Authorization (tRPC)
4. Run Section 4: Database Security (all 3 envs)
5. Run Section 5: Injection Vulnerabilities
6. Run Section 6: Data Exposure
7. Run Section 7: Additional Checks
8. Compile findings by severity
9. Create remediation plan for any issues
10. Run VR-COUPLING check (backend-frontend sync)
11. Produce security report
12. Update session state

---

## VR-COUPLING VERIFICATION (Added Jan 2026)

Security features in backend must be visible/accessible in UI:

```bash
./scripts/check-coupling.sh
# Expected: Exit 0 - all backend features exposed in UI
```

**Why this matters**: Backend security features (like permission levels, access controls) that aren't exposed in UI leave users unable to configure security properly.

---

## AUTO-LEARNING PROTOCOL (MANDATORY after every fix/finding)

**After EVERY fix or finding, the system MUST automatically learn. This is NOT optional.**

### Step 1: Ingest into Memory
Use `mcp__massu-codegraph__massu_memory_ingest` with type="bugfix"|"pattern", description of what was found/fixed, affected files, and importance (5=security/data, 3=build/type, 2=cosmetic).

### Step 2: Record Correct vs Incorrect Pattern
Update `memory/MEMORY.md` with the WRONG vs CORRECT pattern discovered.

### Step 3: Add to Pattern Scanner (if grep-able)
If the bad pattern is detectable by grep, add check to `scripts/pattern-scanner.sh`.

### Step 4: Search Codebase-Wide (CR-9)
`grep -rn "[bad_pattern]" src/` - fix ALL instances of the same issue.

---

**Remember: Zero tolerance for CRITICAL and HIGH issues. Block deployment until fixed.**

---

## Related Audit Commands

| Command | Focus | Overlap | When to Use Instead |
|---------|-------|---------|---------------------|
| /massu-codebase-audit | Full 20-phase audit | Covers security basics | Comprehensive review |
| /massu-security | Security deep-dive | Auth, RLS, XSS | Security-focused work |
| /massu-db-audit | Database integrity | Schema, RLS, stored procs | Database changes |
| /massu-extended-audit | E2E, load, deps, GDPR | Extended coverage | Pre-release |
| /massu-learning-audit | Auto-learning effectiveness | Memory, scanner coverage | Post-incident |
| /massu-import-audit | Import chains, build safety | CR-16/17/19 | Build issues |
| /massu-config-audit | Config-code alignment | CR-22/29 | Config bugs |
| /massu-feature-audit | Sentinel feature coverage | CR-32 | Feature gaps |
