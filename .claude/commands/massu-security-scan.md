---
name: massu-security-scan
description: Deep security audit — OWASP, API auth, Supabase RLS, secrets, headers, dependencies
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# CS Security Scan: Deep Security Audit

## Objective

Comprehensive READ-ONLY security audit across all attack surfaces. Reports all findings with severity classification. Does NOT fix any issues.

**Usage**: `/massu-security-scan` (full scan) or `/massu-security-scan [area]` (focused: owasp, api, rls, secrets, headers, deps, webhooks)

## Workflow Position

Security scan is a diagnostic command. It does NOT modify source code but produces a security audit report with actionable findings.

```
/massu-security-scan  ->  security report  ->  /massu-create-plan (if fixes needed)
```

---

## NON-NEGOTIABLE RULES

- Do NOT modify any files
- Do NOT fix any issues found (report only)
- Report ALL findings including minor
- Always check EVERY table for RLS
- Run ALL dimensions even if early ones find issues
- Security findings are ALWAYS reported, even if they seem low-risk

---

## STEP 0: DETERMINE SCOPE

```bash
# If $ARGUMENTS specifies a focused area, only run that dimension
# Valid areas: owasp, api, rls, secrets, headers, deps, webhooks
# If no argument, run ALL dimensions
```

---

## DIMENSION 1: OWASP TOP 10

### A01 Broken Access Control

```bash
# Missing auth checks in API routes
for f in $(find website/src/app/api -name "route.ts" 2>/dev/null); do
  if ! grep -q 'createServerSupabaseClient\|authenticateApiKey' "$f"; then
    echo "MISSING AUTH: $f"
  fi
done

# Unprotected dashboard pages (should check session)
for f in $(find website/src/app/dashboard -name "page.tsx" 2>/dev/null); do
  if ! grep -q 'redirect\|getSession\|getUser\|auth' "$f"; then
    echo "UNPROTECTED PAGE: $f"
  fi
done

# Direct object reference without ownership check
grep -rn '\.eq.*params\.' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v 'org_id\|user_id'
```

### A02 Cryptographic Failures

```bash
# Hardcoded secrets
grep -rn "sk-[a-zA-Z0-9]\{20,\}" packages/core/src/ website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null
# Weak hashing
grep -rn 'md5\|sha1(' packages/core/src/ website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null
# Missing encryption-at-rest references
grep -rn 'encrypt\|crypto' website/supabase/ --include="*.sql" 2>/dev/null || echo "No encryption found in migrations"
```

### A03 Injection

```bash
# Template literals in SQL (potential SQL injection)
grep -rn '`.*SELECT\|`.*INSERT\|`.*UPDATE\|`.*DELETE' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null
# Unsanitized user input in shell commands
grep -rn 'exec(\|execSync(\|spawn(' packages/core/src/ --include="*.ts" 2>/dev/null
# innerHTML usage
grep -rn 'innerHTML\|dangerouslySetInnerHTML' website/src/ --include="*.tsx" --include="*.ts" 2>/dev/null
```

### A04 Insecure Design

```bash
# Missing rate limiting on sensitive endpoints
for f in $(find website/src/app/api -name "route.ts" 2>/dev/null); do
  if ! grep -q 'rateLimit\|rateLimiter' "$f"; then
    echo "NO RATE LIMIT: $f"
  fi
done
# Missing CSRF protection
grep -rn 'csrf\|CSRF\|csrfToken' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null || echo "No CSRF protection found"
```

### A05 Security Misconfiguration

```bash
# CSP headers
grep -rn 'Content-Security-Policy\|contentSecurityPolicy' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null
# CORS config
grep -rn 'Access-Control-Allow-Origin\|cors' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null
# Debug mode in production
grep -rn 'debug.*true\|DEBUG.*true' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v 'node_modules\|\.test\.'
```

### A06 Vulnerable Components

```bash
npm audit 2>&1 || true
cd website && npm audit 2>&1 || true
```

### A07 Authentication Failures

```bash
# Session management
grep -rn 'session\|getSession\|createSession' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null | head -20
# MFA enforcement
grep -rn 'mfa\|MFA\|totp\|two.factor' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null || echo "No MFA references found"
# Brute force protection
grep -rn 'lockout\|maxAttempts\|login.*attempt' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null || echo "No brute force protection found"
```

### A08 Data Integrity

```bash
# Unsigned webhooks
grep -rn 'webhook' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v 'hmac\|signature\|verify'
# Missing HMAC verification
grep -rn 'hmac\|HMAC\|createHmac' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null || echo "No HMAC verification found"
```

### A09 Logging Failures

```bash
# Audit log coverage
grep -rn 'audit\|log.*event\|logActivity' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null | head -20
# Missing security event logging
grep -rn 'login\|logout\|password.*change\|role.*change' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v 'log\|audit'
```

### A10 SSRF

```bash
# Fetch/axios with user-controlled URLs
grep -rn 'fetch(\|axios\.' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v 'node_modules'
# URL construction from user input
grep -rn 'new URL.*params\|new URL.*query\|new URL.*req' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null
```

```markdown
### OWASP Top 10 Findings

| Category | File:Line | Severity | Description |
|----------|-----------|----------|-------------|
| [A01-A10] | [loc] | CRITICAL/HIGH/MEDIUM/LOW | [desc] |
```

---

## DIMENSION 2: API SECURITY

For all files in `website/src/app/api/`:

```bash
# List all API route files
find website/src/app/api -name "route.ts" 2>/dev/null
```

For EACH route file, check:

| Check | What to Grep | Severity if Missing |
|-------|--------------|---------------------|
| Auth | `createServerSupabaseClient` or `authenticateApiKey` | CRITICAL |
| Rate limiting | `rateLimit(` | HIGH |
| Input validation | `zod` schema or `.parse(` or `.safeParse(` | HIGH |
| Scope enforcement | `scope` check on write endpoints | MEDIUM |
| Response sanitization | No PII/secrets in error responses | MEDIUM |

```markdown
### API Security Matrix

| Endpoint | Auth | Rate Limit | Validation | Scope Check | Status |
|----------|------|------------|------------|-------------|--------|
| [route] | YES/NO | YES/NO | YES/NO | YES/NO/N/A | PASS/FAIL |
```

---

## DIMENSION 3: SUPABASE RLS VERIFICATION

```bash
# For every CREATE TABLE in migrations, check RLS
for f in $(find website/supabase/migrations -name "*.sql" 2>/dev/null | sort); do
  echo "=== $f ==="
  # Extract table names from CREATE TABLE statements
  grep -n 'CREATE TABLE' "$f" 2>/dev/null
  # Check for RLS enablement
  grep -n 'ENABLE ROW LEVEL SECURITY' "$f" 2>/dev/null
  # Check for policies
  grep -n 'CREATE POLICY' "$f" 2>/dev/null
done
```

### RLS Verification Checklist

For every table:
1. `ALTER TABLE [name] ENABLE ROW LEVEL SECURITY` exists
2. At least one SELECT policy exists
3. INSERT/UPDATE policies check ownership (for tables with write operations)
4. service_role policies exist (for edge function access)

```markdown
### Table x Policy Matrix

| Table | RLS Enabled | SELECT Policy | INSERT Policy | UPDATE Policy | service_role | Status |
|-------|-------------|---------------|---------------|---------------|--------------|--------|
| [table] | YES/NO | YES/NO | YES/NO/N/A | YES/NO/N/A | YES/NO | PASS/FAIL |
```

---

## DIMENSION 4: SECRET SCANNING

```bash
# Hardcoded API keys
grep -rn 'sk-[a-zA-Z0-9]\{20,\}' packages/core/src/ website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null
grep -rn "Bearer [a-zA-Z0-9]\{20,\}" packages/core/src/ website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null

# Password patterns
grep -rn "password.*=.*['\"][^'\"]\{8,\}" packages/core/src/ website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null \
  | grep -v 'process.env\|\.test\.ts\|RegExp\|regex\|REDACT\|redact\|sanitize\|mask\|schema\|zod\|type\|interface'

# Check .env files for non-example values
cat website/.env.local 2>/dev/null || echo ".env.local not found"
cat website/.env.example 2>/dev/null | grep -v '^#' | grep '=' | grep -v 'your_\|example\|xxx\|placeholder\|CHANGEME'

# Deleted secret files in git history
git log --diff-filter=D --name-only --pretty="" -- '*.env' '*.pem' '*.key' '*.secret' 2>/dev/null

# NEXT_PUBLIC_ env vars that might contain secrets
grep -rn 'NEXT_PUBLIC_.*SECRET\|NEXT_PUBLIC_.*KEY\|NEXT_PUBLIC_.*PASSWORD' website/ --include="*.env*" 2>/dev/null
grep -rn 'NEXT_PUBLIC_.*SECRET\|NEXT_PUBLIC_.*KEY\|NEXT_PUBLIC_.*PASSWORD' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null
```

```markdown
### Secret Scanning Results

| Type | File:Line | Pattern | Severity | Status |
|------|-----------|---------|----------|--------|
| [type] | [loc] | [pattern] | CRITICAL/HIGH | PASS/FAIL |
```

---

## DIMENSION 5: SECURITY HEADERS

```bash
# Read middleware.ts for security headers
cat website/src/middleware.ts 2>/dev/null || cat website/middleware.ts 2>/dev/null || echo "No middleware.ts found"

# Also check next.config.js/ts for headers
grep -A 20 'headers' website/next.config.* 2>/dev/null || echo "No headers config in next.config"
```

### Required Headers Checklist

| Header | Expected Value | Present? | Status |
|--------|---------------|----------|--------|
| X-Frame-Options | DENY | YES/NO | PASS/FAIL |
| X-Content-Type-Options | nosniff | YES/NO | PASS/FAIL |
| Referrer-Policy | strict-origin-when-cross-origin | YES/NO | PASS/FAIL |
| Permissions-Policy | camera=(), microphone=(), geolocation=() | YES/NO | PASS/FAIL |
| Strict-Transport-Security | max-age=... includeSubDomains | YES/NO | PASS/FAIL |
| Content-Security-Policy | [policy] | YES/NO | PASS/FAIL |

---

## DIMENSION 6: DEPENDENCY VULNERABILITIES

```bash
# Root workspace
echo "=== Root Workspace ==="
npm audit --json 2>/dev/null | head -50 || npm audit 2>&1

# Website
echo "=== Website ==="
cd website && npm audit --json 2>/dev/null | head -50 || npm audit 2>&1
```

### Vulnerability Summary

| Workspace | Critical | High | Medium | Low | Production? |
|-----------|----------|------|--------|-----|-------------|
| Root | [N] | [N] | [N] | [N] | YES/NO |
| Website | [N] | [N] | [N] | [N] | YES/NO |

### Supply Chain Indicators

```bash
# Check for recently published packages (potential supply chain attack)
# Check for packages with very few downloads
# Check for packages with single maintainer + recent ownership transfer
npm ls --depth=0 2>/dev/null
```

---

## DIMENSION 7: WEBHOOK SECURITY

```bash
# Find webhook-related code
grep -rn 'webhook' website/src/ --include="*.ts" --include="*.tsx" 2>/dev/null
grep -rn 'webhook' website/supabase/functions/ --include="*.ts" 2>/dev/null
```

If webhook code exists, check:

| Check | What to Verify | Severity if Missing |
|-------|---------------|---------------------|
| HMAC-SHA256 signature verification | `createHmac.*sha256` or `crypto.subtle.sign` | CRITICAL |
| Timing-safe comparison | `timingSafeEqual` or `crypto.subtle.verify` | HIGH |
| Replay protection | Timestamp validation or idempotency key | MEDIUM |
| Secret rotation capability | Env var for webhook secret (not hardcoded) | MEDIUM |

```markdown
### Webhook Security Findings

| Webhook | HMAC Verification | Timing-Safe | Replay Protection | Secret Rotation | Status |
|---------|-------------------|-------------|-------------------|-----------------|--------|
| [name] | YES/NO | YES/NO | YES/NO | YES/NO | PASS/FAIL |
```

---

## DIMENSION 8: AUTHORIZATION LOGIC

Check that paid features enforce server-side authorization:

1. Find all dashboard pages: `find src/app/(dashboard) -name "page.tsx" -type f`
2. For each, check for `requirePlan()` or equivalent server-side check
3. Find all API routes with tier restrictions and verify enforcement
4. Check API key scope enforcement

```markdown
### Dimension 8: Authorization Logic
| Finding | Severity | File | Details |
|---------|----------|------|---------|
| ... | ... | ... | ... |
```

---

## DIMENSION 9: SSRF PREVENTION

1. Find all `fetch()` calls with dynamic URLs: `grep -rn 'fetch(' src/ --include="*.ts" | grep -v "fetch('https"`
2. For each, verify URL validation (allowlist, IP blocking)
3. Check webhook URL inputs specifically

---

## DIMENSION 10: SECRET LEAKAGE

1. Find all API GET handlers: `grep -rn 'export.*function GET' src/app/api/ -l`
2. For each, check if response includes `secret`, `key`, `password`, `token` fields
3. Check for `select('*')` usage in GET handlers

---

## DIMENSION 11: AUTH COMPLETENESS

1. Find all auth-related files: `grep -rl 'auth\|sso\|login\|callback' src/ --include="*.ts"`
2. Grep for `TODO`, `FIXME`, `stub`, `placeholder`, `In a full implementation`
3. Every auth callback must validate tokens/assertions

---

## DIMENSION 12: ENCRYPTION INTEGRITY

1. Find all encryption/crypto files: `grep -rl 'encrypt\|decrypt\|crypto\|cipher' src/ --include="*.ts"`
2. Check every `catch` block -- must re-throw or return error, never silently swallow
3. No plaintext fallback on encryption failure

---

## COMPLETION REPORT

```markdown
## CS SECURITY SCAN COMPLETE

### Scan Summary
- **Scope**: [full scan / focused: area]
- **Dimensions scanned**: [N]/7
- **Files analyzed**: [N]

### Findings by Severity

| Severity | Count | Dimensions |
|----------|-------|------------|
| CRITICAL | [N] | [which dimensions] |
| HIGH | [N] | [which dimensions] |
| MEDIUM | [N] | [which dimensions] |
| LOW | [N] | [which dimensions] |
| **Total** | **[N]** | |

### Findings by Dimension

| Dimension | Findings | Worst Severity |
|-----------|----------|---------------|
| OWASP Top 10 | [N] | [sev] |
| API Security | [N] | [sev] |
| Supabase RLS | [N] | [sev] |
| Secret Scanning | [N] | [sev] |
| Security Headers | [N] | [sev] |
| Dependency Vulns | [N] | [sev] |
| Webhook Security | [N] | [sev] |

### Top Priority Findings

| # | File:Line | Severity | Type | Description | Recommendation |
|---|-----------|----------|------|-------------|----------------|
| 1 | [loc] | [sev] | [type] | [desc] | [rec] |
| 2 | [loc] | [sev] | [type] | [desc] | [rec] |
| 3 | [loc] | [sev] | [type] | [desc] | [rec] |

### Verdict: SECURE / NEEDS ATTENTION / VULNERABLE

- **SECURE**: 0 critical, 0 high findings
- **NEEDS ATTENTION**: 0 critical, 1+ high findings
- **VULNERABLE**: 1+ critical findings

### Recommended Next Steps
- [Priority actions based on findings]
- Use `/massu-hotfix` or `/massu-create-plan` to address findings
```
