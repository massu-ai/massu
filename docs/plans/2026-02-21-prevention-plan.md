# Prevention Plan: Closing All Verification Gaps

**Date**: 2026-02-21
**Trigger**: Full-scope review found 119 issues including CRITICAL security flaws
**Goal**: Make it structurally impossible for these categories of issues to reach production
**Audit**: v1.5 (verification audit iteration 1 applied 2026-02-21)

---

## Repo Map

| Repo | Path | Contains |
|------|------|----------|
| **massu** (this repo) | `/Users/eko3/massu/` | MCP server, plugin, scripts, commands, CLAUDE.md |
| **massu-internal/website** | `/Users/eko3/massu-internal/website/` | Next.js website, Supabase, API routes, dashboard |

All file paths in this plan are absolute or relative to the repo they belong to.

---

## Root Cause Summary

| Root Cause | Impact | Examples |
|------------|--------|----------|
| All verification is grep-based (static only) | Logic bugs, auth bypasses, business rule violations pass all checks | SSO bypass, missing plan gating, webhook SSRF, wrong tier badges |
| Zero enforced quality gates | Any developer can commit/push without checks | No git hooks, no CI/CD, everything is honor-system |
| Audit tools themselves are broken | Tools meant to catch problems have their own bugs | grep -oP on macOS, CR-35 phantom, missing directories |
| No integration or E2E tests | 880 unit tests but zero tests for user-facing behavior | No test for "can free user access paid page?" |

---

## AREA 1: Enforce Quality Gates (Git Hooks + CI)

### 1.1 Install Git Hooks via Husky

**Files to create/modify:**
- `package.json` — add `husky` and `lint-staged` as devDependencies, add `"prepare": "husky"` script
- `.husky/pre-commit` — fast checks before every commit
- `.husky/pre-push` — thorough checks before every push

**Installation steps:**
```bash
cd /Users/eko3/massu
npm install --save-dev husky lint-staged
npx husky init
```

**Pre-commit hook** (`/Users/eko3/massu/.husky/pre-commit`, < 30 seconds):
```bash
#!/bin/sh
bash scripts/massu-pattern-scanner.sh
bash scripts/massu-security-scanner.sh
```

**Pre-push hook** (`/Users/eko3/massu/.husky/pre-push`, < 3 minutes):
```bash
#!/bin/sh
# Use subshells to avoid cd side-effects between steps
(cd packages/core && npx tsc --noEmit)
npm test
(cd packages/core && npm run build:hooks)
```

**Verification:**
```bash
# VR-FILE: Hooks exist and are executable
ls -la .husky/pre-commit .husky/pre-push
test -x .husky/pre-commit && echo "PASS" || echo "FAIL"
test -x .husky/pre-push && echo "PASS" || echo "FAIL"
# VR-GREP: package.json has husky
grep '"husky"' package.json
grep '"prepare"' package.json
```

### 1.2 Update GitHub Actions CI Pipeline

**File**: `/Users/eko3/massu/.github/workflows/ci.yml` (UPDATE existing file, not create)

**Current state**: Already has type-check, test, and build jobs. Missing: security scanner, integration tests, npm audit.

**Changes to make**: Add these steps to the existing CI:
1. Security scanner step in `type-check` job (after pattern scanner): `bash scripts/massu-security-scanner.sh`
2. New `integration-test` job: `npm run test:integration` (depends on test job)
3. `npm audit --audit-level=high` step in the `build` job

**Verification:**
```bash
# VR-GREP: New steps present
grep 'massu-security-scanner' .github/workflows/ci.yml
grep 'test:integration' .github/workflows/ci.yml
grep 'npm audit' .github/workflows/ci.yml
```

### 1.3 Add Pre-Deploy Verification

**File**: `/Users/eko3/massu/.github/workflows/deploy.yml` (NEW file)

This workflow runs on pushes to `main` only and gates deployment:
```yaml
name: Deploy Gate
on:
  push:
    branches: [main]

jobs:
  deploy-gate:
    name: Pre-Deploy Verification
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - name: All CI checks
        run: |
          bash scripts/massu-pattern-scanner.sh
          bash scripts/massu-security-scanner.sh
          (cd packages/core && npx tsc --noEmit)
          npm test
      - name: Integration tests
        run: npm run test:integration
      - name: Hook compilation
        run: cd packages/core && npm run build:hooks
      - name: npm audit
        run: npm audit --audit-level=high
```

**Verification:**
```bash
# VR-FILE
ls -la .github/workflows/deploy.yml
# VR-GREP
grep 'Deploy Gate' .github/workflows/deploy.yml
```

---

## AREA 2: Fix the Broken Audit Tools

### 2.1 Upgrade `massu-security-scanner.sh`

**File**: `/Users/eko3/massu/scripts/massu-security-scanner.sh`

**Current state**: 7 checks (hardcoded secrets, innerHTML, eval, SQL injection, missing auth, RLS, NEXT_PUBLIC secrets). References `$REPO_ROOT/website/src` which does not exist in this repo (website is in massu-internal). Existing checks gracefully skip with `if [ -d "$DIR" ]` guards.

**New checks to append** (Checks 8-11, after existing Check 7). These checks operate on the website repo IF `$WEBSITE_SRC` exists, otherwise skip gracefully:

```bash
# Check 8: No select('*') in API GET handlers
# Grep $API_DIR for "select('*')" or 'select("*")' in route.ts files
# that also contain 'export async function GET'
echo "Check 8: No select('*') in API GET handlers"
SELECT_STAR=0
if [ -d "$API_DIR" ]; then
  while IFS= read -r ROUTE_FILE; do
    HAS_GET=$(grep -c 'export.*function GET\|export.*GET' "$ROUTE_FILE" 2>/dev/null || true)
    HAS_SELECT_STAR=$(grep -c "select(['\"]\\*['\"])" "$ROUTE_FILE" 2>/dev/null || true)
    if [ "$HAS_GET" -gt 0 ] && [ "$HAS_SELECT_STAR" -gt 0 ]; then
      SELECT_STAR=$((SELECT_STAR + 1))
      warn "  select('*') in GET handler: ${ROUTE_FILE#"$REPO_ROOT"/}"
    fi
  done < <(find "$API_DIR" -name "route.ts" -type f 2>/dev/null)
fi
if [ "$SELECT_STAR" -gt 0 ]; then
  fail "$SELECT_STAR API GET routes use select('*')"
else
  pass "No select('*') in API GET handlers"
fi

# Check 9: No TODO/stub in auth code
echo "Check 9: No TODO/stub patterns in auth code"
AUTH_STUBS=0
if [ -d "$WEBSITE_SRC" ]; then
  AUTH_STUBS=$(grep -rn 'TODO\|FIXME\|In a full implementation\|stub\|placeholder' "$WEBSITE_SRC" --include="*.ts" --include="*.tsx" \
    | grep -i 'auth\|sso\|login\|session\|token\|callback' \
    | grep -v 'node_modules' | grep -v '__tests__' \
    | wc -l | tr -d ' ')
fi
if [ "$AUTH_STUBS" -gt 0 ]; then
  fail "Found $AUTH_STUBS TODO/stub patterns in auth-related code"
else
  pass "No TODO/stub patterns in auth code"
fi

# Check 10: No silent catch in encryption code
echo "Check 10: No silent catch blocks in encryption/crypto code"
# (grep for catch blocks in files containing encrypt/decrypt/crypto)
SILENT_CATCH=0
if [ -d "$WEBSITE_SRC" ]; then
  for CRYPTO_FILE in $(grep -rl 'encrypt\|decrypt\|crypto\|cipher' "$WEBSITE_SRC" --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v node_modules | grep -v __tests__); do
    CATCH_COUNT=$(grep -c 'catch.*{' "$CRYPTO_FILE" 2>/dev/null || true)
    RETHROW_COUNT=$(grep -c 'throw\|console\.error\|logger\.' "$CRYPTO_FILE" 2>/dev/null || true)
    if [ "$CATCH_COUNT" -gt 0 ] && [ "$RETHROW_COUNT" -eq 0 ]; then
      SILENT_CATCH=$((SILENT_CATCH + 1))
      warn "  Possibly silent catch in crypto file: ${CRYPTO_FILE#"$REPO_ROOT"/}"
    fi
  done
fi
if [ "$SILENT_CATCH" -gt 0 ]; then
  fail "$SILENT_CATCH crypto files may have silent error handling"
else
  pass "No silent catch blocks in encryption code"
fi

# Check 11: All fetch() with user-supplied URLs have validation
echo "Check 11: SSRF - fetch() calls with dynamic URLs"
# (Look for fetch(variable) not fetch('https://hardcoded'))
SSRF_RISK=0
if [ -d "$WEBSITE_SRC" ]; then
  SSRF_RISK=$(grep -rn 'fetch(' "$WEBSITE_SRC" --include="*.ts" --include="*.tsx" \
    | grep -v 'node_modules' | grep -v '__tests__' \
    | grep -v "fetch(['\"]https\?://" \
    | grep -v "fetch(['\"]/" \
    | grep -v 'fetchClient\|fetchApi\|supabase' \
    | wc -l | tr -d ' ')
fi
if [ "$SSRF_RISK" -gt 0 ]; then
  warn "Found $SSRF_RISK fetch() calls with potentially dynamic URLs (review for SSRF)"
else
  pass "No suspicious dynamic fetch() URLs found"
fi
```

**Verification:**
```bash
# VR-GREP: New checks present
grep -c 'Check 8\|Check 9\|Check 10\|Check 11' scripts/massu-security-scanner.sh
# Should be >= 4
# VR-BUILD: Script runs without syntax errors
bash -n scripts/massu-security-scanner.sh && echo "PASS" || echo "FAIL"
```

### 2.2 Fix `massu-push.md` Portability

**File**: `/Users/eko3/massu/.claude/commands/massu-push.md`

**Lines to fix**: 88-92 (4 instances of `grep -oP` which is GNU-only, fails on macOS)

**Replace EACH instance** with portable alternatives:
```bash
# OLD (line 88):
BASELINE_PASS=$(grep -oP 'Tests\s+\K\d+(?=\s+passed)' /tmp/baseline-tests.txt || echo 0)
# NEW:
BASELINE_PASS=$(sed -n 's/.*Tests[[:space:]]*\([0-9]*\)[[:space:]]*passed.*/\1/p' /tmp/baseline-tests.txt | head -1)
[ -z "$BASELINE_PASS" ] && BASELINE_PASS=0

# OLD (line 89):
BASELINE_FAIL=$(grep -oP '\K\d+(?=\s+failed)' /tmp/baseline-tests.txt || echo 0)
# NEW:
BASELINE_FAIL=$(sed -n 's/.*\([0-9]*\)[[:space:]]*failed.*/\1/p' /tmp/baseline-tests.txt | head -1)
[ -z "$BASELINE_FAIL" ] && BASELINE_FAIL=0

# OLD (line 91):
CURRENT_PASS=$(grep -oP 'Tests\s+\K\d+(?=\s+passed)' /tmp/current-tests.txt || echo 0)
# NEW:
CURRENT_PASS=$(sed -n 's/.*Tests[[:space:]]*\([0-9]*\)[[:space:]]*passed.*/\1/p' /tmp/current-tests.txt | head -1)
[ -z "$CURRENT_PASS" ] && CURRENT_PASS=0

# OLD (line 92):
CURRENT_FAIL=$(grep -oP '\K\d+(?=\s+failed)' /tmp/current-tests.txt || echo 0)
# NEW:
CURRENT_FAIL=$(sed -n 's/.*\([0-9]*\)[[:space:]]*failed.*/\1/p' /tmp/current-tests.txt | head -1)
[ -z "$CURRENT_FAIL" ] && CURRENT_FAIL=0
```

**Verification:**
```bash
# VR-NEGATIVE: No grep -oP remains
grep -c 'grep -oP' .claude/commands/massu-push.md
# Must be 0
```

### 2.3 Replace Phantom CR-35 References

**Problem**: 45 files reference CR-35 but it does not exist in CLAUDE.md (which only has CR-1 through CR-12). The new CRs in this plan are CR-13 through CR-17.

**Decision**: CR-35 was a phantom rule. The intended meaning ("Session state must record AUTHORIZED_COMMAND before executing destructive commands") does NOT need to be a canonical rule -- it is an operational pattern already enforced by the commands themselves. Instead, all 45 references to CR-35 should be replaced with a reference to the applicable real CRs.

**Action**: In every file under `/Users/eko3/massu/.claude/commands/` and `/Users/eko3/massu/.claude/` that references CR-35:
- Replace `CR-9, CR-35 enforced` with `CR-9 enforced`
- Remove standalone `CR-35` references

**Files affected** (45 files including `.claude/settings.json` and 44 command/preamble files):
```bash
grep -rl 'CR-35' .claude/
```

**Verification:**
```bash
# VR-NEGATIVE: No CR-35 references remain
grep -rn 'CR-35' .claude/
# Must return 0 results
```

### 2.4 Fix All Broken Command References

| Fix | Files | Exact Change | Verification |
|-----|-------|--------------|--------------|
| Remove duplicate `name:` field (the bare one OUTSIDE frontmatter, after the closing `---`) | 41 command files (all `massu-*.md` except `massu-sync-public.md` and `massu-feature-parity.md` which only have one `name:`) | Delete the line matching `^name: massu-.*` that appears AFTER the second `---` (line 6 in most files) | `for f in .claude/commands/*.md; do c=$(grep -c '^name:' "$f"); [ "$c" -gt 1 ] && echo "FAIL: $f"; done` (expect 0 output) |
| Add YAML frontmatter to `massu-sync-public.md` | `/Users/eko3/massu/.claude/commands/massu-sync-public.md` | Wrap existing `name:` in frontmatter: `---\nname: massu-sync-public\ndescription: "Run quality gates on massu-internal, then sync public files to massu public repo"\nallowed-tools: Bash(*), Read(*), Grep(*), Glob(*)\n---` | `head -3 .claude/commands/massu-sync-public.md` shows `---` on line 1 |
| Create `.claude/patterns/` directory | `/Users/eko3/massu/.claude/patterns/` | `mkdir -p .claude/patterns && touch .claude/patterns/.gitkeep` | `ls -la .claude/patterns/.gitkeep` |
| Create `.claude/incidents/` directory | `/Users/eko3/massu/.claude/incidents/` | `mkdir -p .claude/incidents && touch .claude/incidents/.gitkeep` | `ls -la .claude/incidents/.gitkeep` |
| Create `.claude/benchmarks/` directory | `/Users/eko3/massu/.claude/benchmarks/` | `mkdir -p .claude/benchmarks && touch .claude/benchmarks/.gitkeep` | `ls -la .claude/benchmarks/.gitkeep` |
| Fix hardcoded paths in `massu-feature-parity.md` | `/Users/eko3/massu/.claude/commands/massu-feature-parity.md` | Replace ALL hardcoded paths in the Configuration block (lines 20-25). Replace lines 20-22 (`LIMN_ROOT`, `LIMN_MCP`, `LIMN_CLAUDE`) with parameterized versions: `LIMN_ROOT="${LIMN_ROOT:-$ARGUMENTS}"` with guard. Replace lines 23-25 (`MASSU_ROOT`, `MASSU_MCP`, `MASSU_CLAUDE`) similarly: `MASSU_ROOT="${MASSU_ROOT:-/Users/eko3/massu-internal}"` (with env var override). Derive `*_MCP` and `*_CLAUDE` from the root vars. | `grep -c '/Users/eko3/limn-systems' .claude/commands/massu-feature-parity.md` returns 0 AND `grep -c '/Users/eko3/massu-internal' .claude/commands/massu-feature-parity.md` returns 0 |
| Fix `massu-checkpoint.md` subagent type | `/Users/eko3/massu/.claude/commands/massu-checkpoint.md` | The `Task(subagent_type="massu-plan-auditor")` references a non-existent subagent type. Replace with direct execution: change "Spawn a `massu-plan-auditor` subagent" to "Execute the checkpoint pass inline" on line 21, remove `subagent_type="massu-plan-auditor"` on line 34, and change "Spawn `massu-plan-auditor` subagent" to "Execute checkpoint" on line 518 (3 lines total) | `grep -c 'subagent_type' .claude/commands/massu-checkpoint.md` returns 0 AND `grep -c 'massu-plan-auditor' .claude/commands/massu-checkpoint.md` returns 0 |
| Fix Co-Authored-By inconsistency | `/Users/eko3/massu/.claude/commands/massu-checkpoint.md` (line 425) | Change `Co-Authored-By: Claude <noreply@anthropic.com>` to `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>` to match the canonical form in massu-commit.md, massu-hotfix.md, massu-release.md | `grep 'Co-Authored-By' .claude/commands/massu-checkpoint.md` shows `Claude Opus 4.6` |

### 2.5 Create Script Self-Test

**File**: `/Users/eko3/massu/scripts/massu-verify-tooling.sh` (NEW)

```bash
#!/usr/bin/env bash
#
# massu-verify-tooling.sh - Verify that all massu verification tools work
#
# Exit 0 = all tools functional, Exit 1 = broken tools found
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; FAILURES=$((FAILURES + 1)); }

echo "=== Massu Tooling Self-Test ==="

# 1. All shell scripts have set -uo pipefail (or set -euo pipefail)
echo "Check 1: Shell scripts have strict mode"
for SCRIPT in "$REPO_ROOT"/scripts/massu-*.sh; do
  if ! grep -q 'set -[eu]*o pipefail' "$SCRIPT" 2>/dev/null; then
    fail "Missing strict mode: $(basename "$SCRIPT")"
  fi
done
[ "$FAILURES" -eq 0 ] && pass "All scripts have strict mode"

# 2. All command files have valid YAML frontmatter (--- on line 1 and line N)
echo "Check 2: Command files have YAML frontmatter"
PREV_FAILURES=$FAILURES
for CMD in "$REPO_ROOT"/.claude/commands/massu-*.md; do
  FIRST_LINE=$(head -1 "$CMD")
  if [ "$FIRST_LINE" != "---" ]; then
    fail "Missing frontmatter: $(basename "$CMD")"
  fi
done
[ "$FAILURES" -eq "$PREV_FAILURES" ] && pass "All commands have frontmatter"

# 3. No duplicate name: fields in command files
echo "Check 3: No duplicate name: fields"
PREV_FAILURES=$FAILURES
for CMD in "$REPO_ROOT"/.claude/commands/massu-*.md; do
  COUNT=$(grep -c '^name:' "$CMD" 2>/dev/null)
  if [ "$COUNT" -gt 1 ]; then
    fail "Duplicate name: in $(basename "$CMD")"
  fi
done
[ "$FAILURES" -eq "$PREV_FAILURES" ] && pass "No duplicate name: fields"

# 4. All referenced directories exist
echo "Check 4: Referenced directories exist"
PREV_FAILURES=$FAILURES
for DIR in .claude/patterns .claude/incidents .claude/benchmarks .claude/session-state; do
  if [ ! -d "$REPO_ROOT/$DIR" ]; then
    fail "Missing directory: $DIR"
  fi
done
[ "$FAILURES" -eq "$PREV_FAILURES" ] && pass "All referenced directories exist"

# 5. All referenced scripts exist
echo "Check 5: Referenced scripts exist"
PREV_FAILURES=$FAILURES
for SCRIPT in massu-pattern-scanner.sh massu-security-scanner.sh massu-verify-tooling.sh; do
  if [ ! -f "$REPO_ROOT/scripts/$SCRIPT" ]; then
    fail "Missing script: scripts/$SCRIPT"
  fi
done
[ "$FAILURES" -eq "$PREV_FAILURES" ] && pass "All referenced scripts exist"

# 6. No grep -oP (GNU-only) in any script or command
echo "Check 6: No GNU-only grep flags"
PREV_FAILURES=$FAILURES
GNU_GREP=$(grep -rn 'grep -[a-zA-Z]*P' "$REPO_ROOT"/.claude/commands/ "$REPO_ROOT"/scripts/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$GNU_GREP" -gt 0 ]; then
  fail "Found $GNU_GREP grep -P (GNU-only) usages"
else
  pass "No GNU-only grep flags"
fi

# 7. All CR-N references in commands resolve to CLAUDE.md
echo "Check 7: All CR-N references resolve"
PREV_FAILURES=$FAILURES
CR_REFS=$(grep -oh 'CR-[0-9]*' "$REPO_ROOT"/.claude/commands/*.md 2>/dev/null | sort -u)
for CR in $CR_REFS; do
  if ! grep -q "$CR" "$REPO_ROOT/.claude/CLAUDE.md" 2>/dev/null; then
    fail "Unresolved reference: $CR"
  fi
done
[ "$FAILURES" -eq "$PREV_FAILURES" ] && pass "All CR-N references resolve"

echo ""
echo "=== Tooling Self-Test Summary ==="
if [ "$FAILURES" -gt 0 ]; then
  echo -e "${RED}FAIL: $FAILURES issue(s) found${NC}"
  exit 1
else
  echo -e "${GREEN}PASS: All tooling checks passed${NC}"
  exit 0
fi
```

**NOTE**: The code block above already uses the macOS-compatible `grep -oh 'CR-[0-9]*'` (no `-P` flag). Ensure no GNU-only flags creep in during implementation.

**Verification:**
```bash
# VR-FILE
ls -la scripts/massu-verify-tooling.sh
# VR-BUILD: Syntax check
bash -n scripts/massu-verify-tooling.sh && echo "PASS"
# VR-NEGATIVE: No GNU-only grep in the script itself
grep -c 'grep.*-P' scripts/massu-verify-tooling.sh
# Must be 0
```

---

## AREA 3: Add Business Logic & Integration Tests

### 3.1 Website Integration Tests (NEW)

**Repo**: massu-internal (NOT this repo)
**Directory**: `/Users/eko3/massu-internal/website/src/__tests__/integration/` (CREATE this subdirectory)
**Test framework**: vitest (already configured in `/Users/eko3/massu-internal/website/vitest.config.ts`)
**Existing tests**: `/Users/eko3/massu-internal/website/src/__tests__/` already has `auth.test.ts`, `dashboard-data.test.ts`, `rate-limit.test.ts`, `stripe-events.test.ts`

| Test File | What It Tests | Test Strategy | Key Assertions |
|-----------|--------------|---------------|----------------|
| `plan-gating.test.ts` | Every paid dashboard page returns 403/redirect for free users | Enumerate all routes under `src/app/(dashboard)/` that import plan-gated components; for each, call the page handler with a free-tier mock user and assert redirect or 403 | `expect(response.status).toBe(403)` or `expect(redirect).toContain('/upgrade')` |
| `api-auth.test.ts` | Every API route rejects unauthenticated requests | `fs.readdirSync` to find all `route.ts` under `src/app/api/`; for each non-public route, call handler with no auth header | `expect(response.status).toBe(401)` |
| `api-secrets.test.ts` | No API GET response contains `secret`, `key`, or `password` fields | For each API GET route, call with valid auth and check response body keys | `expect(Object.keys(body)).not.toContain('secret')` etc. |
| `sso-validation.test.ts` | SSO callback rejects invalid assertions/codes | Call SSO callback endpoint with empty/malformed/expired tokens | `expect(response.status).toBe(400)` |
| `webhook-ssrf.test.ts` | Webhook URL validation rejects internal IPs, localhost, metadata endpoints | Call webhook creation with URLs: `http://127.0.0.1`, `http://169.254.169.254`, `http://localhost`, `http://[::1]` | `expect(response.status).toBe(400)` for all |
| `tier-display.test.ts` | Features page shows correct badge per tool tier | Import features data, render component, check badge text matches tier from config | `expect(badge.textContent).toBe(tool.tier)` |
| `rate-limiting.test.ts` | All public endpoints have rate limiting configured | For each public route, send N+1 requests rapidly | `expect(responses[N].status).toBe(429)` |
| `encryption-failure.test.ts` | Encryption failure throws error, does NOT fall back to plaintext | Mock crypto to throw, call encrypt function | `expect(() => encrypt(data)).toThrow()` |

**Verification:**
```bash
# VR-FILE: All test files exist
ls /Users/eko3/massu-internal/website/src/__tests__/integration/*.test.ts | wc -l
# Must be 8
# VR-TEST: Tests pass
cd /Users/eko3/massu-internal/website && npx vitest run src/__tests__/integration/
```

### 3.2 MCP Server Integration Tests (NEW)

**Repo**: massu (this repo)
**Directory**: `/Users/eko3/massu/packages/core/src/__tests__/integration/` (CREATE this subdirectory)
**Test framework**: vitest (already configured)
**npm script**: Add `"test:integration": "vitest run src/__tests__/integration/"` to `/Users/eko3/massu/packages/core/package.json`. Also add `"test:integration": "npm run test:integration --workspace=packages/core"` to root `/Users/eko3/massu/package.json`.

| Test File | What It Tests | Test Strategy | Key Assertions |
|-----------|--------------|---------------|----------------|
| `path-traversal.test.ts` | All file-reading tools reject paths outside project root | Call each tool that reads files (e.g., `massu_context`) with paths like `../../etc/passwd`, `/etc/passwd`, paths with `..` | `expect(result.content[0].text).toContain('Error')` or tool returns error |
| `tool-registration.test.ts` | Every tool in `getToolDefinitions()` has a matching handler in `handleToolCall()` | Call `getToolDefinitions()`, iterate over all tool names, call `handleToolCall()` for each with minimal valid args | No tool returns "Unknown tool" |
| `pricing-consistency.test.ts` | `DEFAULT_MODEL_PRICING` in `cost-tracker.ts` matches `massu.config.yaml` pricing values | Import both, compare every key-value pair | `expect(codePricing).toEqual(configPricing)` |

**Verification:**
```bash
# VR-FILE: Directory and test files exist
ls /Users/eko3/massu/packages/core/src/__tests__/integration/*.test.ts | wc -l
# Must be 3
# VR-GREP: npm script exists
grep 'test:integration' /Users/eko3/massu/packages/core/package.json
grep 'test:integration' /Users/eko3/massu/package.json
# VR-TEST: Tests pass
cd /Users/eko3/massu && npm run test:integration
```

### 3.3 Add Pre-Launch Checklist Script

**File**: `/Users/eko3/massu/scripts/massu-launch-readiness.sh` (NEW)

**Scope**: This script runs checks on BOTH repos. It accepts the website repo path as an argument.

```bash
#!/usr/bin/env bash
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEBSITE_ROOT="${1:-/Users/eko3/massu-internal/website}"
FAILURES=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; FAILURES=$((FAILURES + 1)); }

echo "=== Massu Launch Readiness Check ==="

# 1. MCP repo quality gates
echo "--- MCP Server Checks ---"
echo "Check 1: Pattern scanner"
bash "$REPO_ROOT/scripts/massu-pattern-scanner.sh" || FAILURES=$((FAILURES + 1))

echo "Check 2: Security scanner"
bash "$REPO_ROOT/scripts/massu-security-scanner.sh" || FAILURES=$((FAILURES + 1))

echo "Check 3: Type check"
(cd "$REPO_ROOT/packages/core" && npx tsc --noEmit) || FAILURES=$((FAILURES + 1))

echo "Check 4: Unit tests"
(cd "$REPO_ROOT" && npm test) || FAILURES=$((FAILURES + 1))

echo "Check 5: Integration tests"
(cd "$REPO_ROOT" && npm run test:integration) || FAILURES=$((FAILURES + 1))

echo "Check 6: Hook compilation"
(cd "$REPO_ROOT/packages/core" && npm run build:hooks) || FAILURES=$((FAILURES + 1))

echo "Check 7: Tooling self-test"
bash "$REPO_ROOT/scripts/massu-verify-tooling.sh" || FAILURES=$((FAILURES + 1))

echo "Check 8: npm audit"
(cd "$REPO_ROOT" && npm audit --audit-level=high) || FAILURES=$((FAILURES + 1))

echo "Check 9: Git hooks installed"
if [ -f "$REPO_ROOT/.husky/pre-commit" ] && [ -f "$REPO_ROOT/.husky/pre-push" ]; then
  pass "Git hooks installed"
else
  fail "Git hooks not installed"
fi

# 10-12. Website checks (only if website repo exists)
if [ -d "$WEBSITE_ROOT" ]; then
  echo "--- Website Checks ---"
  echo "Check 10: Website integration tests"
  (cd "$WEBSITE_ROOT" && npx vitest run src/__tests__/integration/) || FAILURES=$((FAILURES + 1))

  echo "Check 11: Website type check"
  (cd "$WEBSITE_ROOT" && npx tsc --noEmit) || FAILURES=$((FAILURES + 1))

  echo "Check 12: npm audit (website)"
  (cd "$WEBSITE_ROOT" && npm audit --audit-level=high) || FAILURES=$((FAILURES + 1))
else
  echo "SKIP: Website repo not found at $WEBSITE_ROOT"
fi

# Summary
echo ""
echo "=== Launch Readiness Summary ==="
if [ "$FAILURES" -gt 0 ]; then
  echo "FAIL: $FAILURES check(s) failed - NOT ready for launch"
  exit 1
else
  echo "PASS: All checks passed - ready for launch"
  exit 0
fi
```

**Verification:**
```bash
# VR-FILE
ls -la scripts/massu-launch-readiness.sh
# VR-BUILD: Syntax check
bash -n scripts/massu-launch-readiness.sh && echo "PASS"
```

---

## AREA 4: Update Existing Commands to Catch These Issues

### 4.1 Update `massu-codebase-audit.md`

**File**: `/Users/eko3/massu/.claude/commands/massu-codebase-audit.md`

**Location**: Add to the AUDIT SCOPE table (after Phase 13) and add corresponding section content.

**Add these phases to the table:**
```markdown
| 14 | Business Logic Audit | Grep for plan-gating patterns, tier enforcement, auth completeness | HIGH |
| 15 | Security Logic Audit | Run enhanced security scanner + manual SSRF/auth/encryption review | HIGH |
| 16 | Marketing Accuracy | Compare feature counts in config vs website display | MEDIUM |
| 17 | Tooling Self-Check | `bash scripts/massu-verify-tooling.sh` | MEDIUM |
```

**Add section content for each new phase** (matching existing phase format with heading, description, commands, and expected output):

Phase 14 content:
```markdown
## PHASE 14: BUSINESS LOGIC AUDIT

Check that tier-restricted features are properly gated:
1. Grep website dashboard pages for `requirePlan()` calls
2. Verify every paid route has server-side plan enforcement
3. Check pricing constants in code match `massu.config.yaml`
4. Verify no `TODO` or stub implementations in auth flows

Commands:
\`\`\`bash
# Plan gating coverage
grep -rn 'requirePlan' /Users/eko3/massu-internal/website/src/app/ --include="*.ts" --include="*.tsx" | wc -l
# Auth stubs
grep -rn 'TODO\|FIXME\|stub' /Users/eko3/massu-internal/website/src/ --include="*.ts" | grep -i auth | head -20
\`\`\`
```

Phase 15: Run `bash scripts/massu-security-scanner.sh` (enhanced version) and review output.
Phase 16: Compare `massu.config.yaml` tool counts/tiers against website features page data.
Phase 17: Run `bash scripts/massu-verify-tooling.sh`.

**Also update these existing sections in `massu-codebase-audit.md`:**
1. Line 219: Change `Phases Passed: X/13` to `Phases Passed: X/17`
2. EXECUTION CHECKLIST (lines 253-274): Add `- [ ] Phase 14: Business Logic Audit` and `- [ ] Phase 15: Security Logic Audit` under "High Priority (Should Pass)", and `- [ ] Phase 16: Marketing Accuracy` and `- [ ] Phase 17: Tooling Self-Check` under "Medium Priority (Review)"

**Verification:**
```bash
# VR-GREP: New phases present
grep -c 'PHASE 14\|PHASE 15\|PHASE 16\|PHASE 17' .claude/commands/massu-codebase-audit.md
# Must be 4
# VR-GREP: Phase count updated
grep 'X/17' .claude/commands/massu-codebase-audit.md
# VR-GREP: Checklist updated
grep -c 'Phase 14\|Phase 15\|Phase 16\|Phase 17' .claude/commands/massu-codebase-audit.md
# Must be >= 8 (4 headings + 4 checklist items)
```

### 4.2 Update `massu-security-scan.md`

**File**: `/Users/eko3/massu/.claude/commands/massu-security-scan.md`

**Location**: Add after DIMENSION 7 (Webhook Security).

**Add 5 new dimensions** matching existing dimension format (each has: heading, description, step-by-step grep commands, output template):

```markdown
## DIMENSION 8: AUTHORIZATION LOGIC

Check that paid features enforce server-side authorization:

1. Find all dashboard pages: `find src/app/(dashboard) -name "page.tsx" -type f`
2. For each, check for `requirePlan()` or equivalent server-side check
3. Find all API routes with tier restrictions and verify enforcement
4. Check API key scope enforcement

\`\`\`markdown
### Dimension 8: Authorization Logic
| Finding | Severity | File | Details |
|---------|----------|------|---------|
| ... | ... | ... | ... |
\`\`\`

## DIMENSION 9: SSRF PREVENTION

1. Find all `fetch()` calls with dynamic URLs: `grep -rn 'fetch(' src/ --include="*.ts" | grep -v "fetch('https"`
2. For each, verify URL validation (allowlist, IP blocking)
3. Check webhook URL inputs specifically

## DIMENSION 10: SECRET LEAKAGE

1. Find all API GET handlers: `grep -rn 'export.*function GET' src/app/api/ -l`
2. For each, check if response includes `secret`, `key`, `password`, `token` fields
3. Check for `select('*')` usage in GET handlers

## DIMENSION 11: AUTH COMPLETENESS

1. Find all auth-related files: `grep -rl 'auth\|sso\|login\|callback' src/ --include="*.ts"`
2. Grep for `TODO`, `FIXME`, `stub`, `placeholder`, `In a full implementation`
3. Every auth callback must validate tokens/assertions

## DIMENSION 12: ENCRYPTION INTEGRITY

1. Find all encryption/crypto files: `grep -rl 'encrypt\|decrypt\|crypto\|cipher' src/ --include="*.ts"`
2. Check every `catch` block -- must re-throw or return error, never silently swallow
3. No plaintext fallback on encryption failure
```

**Verification:**
```bash
# VR-GREP: New dimensions present
grep -c 'DIMENSION 8\|DIMENSION 9\|DIMENSION 10\|DIMENSION 11\|DIMENSION 12' .claude/commands/massu-security-scan.md
# Must be 5
```

### 4.3 Update `massu-review.md`

**File**: `/Users/eko3/massu/.claude/commands/massu-review.md`

**Location**: Add after DIMENSION 7 (Accessibility Review).

**Add DIMENSION 8:**
```markdown
## DIMENSION 8: BUSINESS LOGIC REVIEW (for all changed files)

Check business logic correctness in changed files:

| Check | Command | Severity if Violated |
|-------|---------|---------------------|
| Plan gating | Verify any new/changed dashboard pages have `requirePlan()` | CRITICAL |
| Pricing consistency | If pricing constants changed, verify they match `massu.config.yaml` | HIGH |
| Tier display | If tier/badge UI changed, verify correct tier per config | HIGH |
| Feature claims | If marketing copy changed, verify counts match actual data | HIGH |
| Auth completeness | No new TODO/stub in auth flows | CRITICAL |

For each changed file, check:
1. If it's a dashboard page: does it have plan gating?
2. If it touches pricing: do values match config?
3. If it touches auth: is it complete (no stubs)?
4. If it touches marketing: do claims match data?
```

**Verification:**
```bash
# VR-GREP
grep -c 'DIMENSION 8' .claude/commands/massu-review.md
# Must be 1
```

### 4.4 Update `massu-commit.md`

**File**: `/Users/eko3/massu/.claude/commands/massu-commit.md`

**Location**: Add after Gate 7 (Plan Coverage), before the Gate summary section.

**Add Gate 8:**
```markdown
### Gate 8: Integration Tests (if integration tests exist)
```bash
# Only run if test:integration script exists
npm run test:integration 2>/dev/null || echo "SKIP: No integration tests configured"
```
```

**Also update these existing sections in `massu-commit.md`:**
1. Line 48: Change "Gates 1-7" to "Gates 1-8"
2. GATE SUMMARY table (line ~261-269): Add row `| 8. Integration Tests | npm run test:integration | [X] pass | PASS/FAIL |`

**Prerequisite**: The `test:integration` npm script must exist (added in 3.2).

**Verification:**
```bash
# VR-GREP
grep -c 'Gate 8' .claude/commands/massu-commit.md
# Must be at least 2 (section heading + summary table row)
grep 'Gates 1-8' .claude/commands/massu-commit.md
```

### 4.5 Update `massu-push.md`

**File**: `/Users/eko3/massu/.claude/commands/massu-push.md`

**Location**: Add after Tier 3 (Security & Compliance).

**Add Tier 4:**
```markdown
### Tier 4: Business Logic Verification

```bash
# Run integration tests
npm run test:integration

# Verify tooling self-test
bash scripts/massu-verify-tooling.sh
```

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Integration tests | `npm run test:integration` | All tests pass |
| Tooling self-test | `bash scripts/massu-verify-tooling.sh` | Exit 0 |
```

**Also update these existing sections in `massu-push.md`:**
1. Line 273 ("Run Tier 1, Tier 2, and Tier 3 in order"): Change to "Run Tier 1, Tier 2, Tier 3, and Tier 4 in order. Stop at first tier failure."
2. PUSH GATE SUMMARY table (line ~285): Add row `| Tier 4 | Business Logic Verification | PASS/FAIL |`
3. DUAL VERIFICATION GATE table (line 290): Change `Tiers 1-3` to `Tiers 1-4`

**Verification:**
```bash
# VR-GREP
grep -c 'Tier 4' .claude/commands/massu-push.md
# Must be at least 3 (section heading + execution flow + summary table)
# VR-GREP: DUAL VERIFICATION GATE updated
grep 'Tiers 1-4' .claude/commands/massu-push.md
```

### 4.6 New Command: `massu-pre-launch.md`

**File**: `/Users/eko3/massu/.claude/commands/massu-pre-launch.md` (NEW)

```markdown
---
name: massu-pre-launch
description: "Comprehensive pre-launch/pre-deploy verification across both repos"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Massu Pre-Launch: Comprehensive Deployment Readiness Check

## Objective

Run ALL verification gates across both repos before any production deployment or major release. This is READ-ONLY -- it reports findings but does not fix them.

---

## NON-NEGOTIABLE RULES

- Run ALL checks even if early ones fail
- Report ALL findings with severity
- Do NOT skip any section
- Do NOT mark as ready if ANY CRITICAL/HIGH finding exists

---

## STEP 1: MCP Server Quality Gates

\`\`\`bash
bash scripts/massu-pattern-scanner.sh
bash scripts/massu-security-scanner.sh
cd packages/core && npx tsc --noEmit
npm test
npm run test:integration
cd packages/core && npm run build:hooks
bash scripts/massu-verify-tooling.sh
\`\`\`

## STEP 2: Website Quality Gates

\`\`\`bash
cd /Users/eko3/massu-internal/website
npx tsc --noEmit
npx vitest run
npx vitest run src/__tests__/integration/
npm audit --audit-level=high
\`\`\`

## STEP 3: Business Logic Audit

1. Verify plan gating on all paid dashboard pages
2. Verify pricing consistency (config vs code)
3. Verify marketing claims match actual data
4. Verify auth completeness (no stubs)

## STEP 4: Security Audit

1. Run enhanced security scanner
2. Verify SSRF protection on all webhook URLs
3. Verify no API responses leak secrets
4. Verify encryption fails hard

## STEP 5: Infrastructure

1. Verify git hooks installed: `ls .husky/pre-commit .husky/pre-push`
2. Verify npm package installable: `npm pack --dry-run`
3. Verify all environment variables documented

## STEP 6: Report

\`\`\`markdown
### Pre-Launch Readiness Report
- **Date**: [date]
- **MCP Quality Gates**: PASS/FAIL
- **Website Quality Gates**: PASS/FAIL
- **Business Logic**: PASS/FAIL
- **Security**: PASS/FAIL
- **Infrastructure**: PASS/FAIL
- **OVERALL**: READY / NOT READY
- **Blockers**: [list if any]
\`\`\`
```

**Verification:**
```bash
# VR-FILE
ls -la .claude/commands/massu-pre-launch.md
# VR-GREP: Has frontmatter
head -1 .claude/commands/massu-pre-launch.md
# Must be "---"
```

---

## AREA 5: Ongoing Prevention (New Canonical Rules)

**File**: `/Users/eko3/massu/.claude/CLAUDE.md`

**Location**: Add to the "Canonical Rules (CR)" table (after CR-12) and add detailed sections for each.

### 5.1 Rule: No Stub Auth Code in Production

**Add to CR table:**
```markdown
| CR-13 | No stub/TODO auth code in production | VR-GREP |
```

**Add detailed section:**
```markdown
### CR-13: No Stub Auth Code in Production

**Authentication and authorization code MUST be complete. TODO/stub implementations in auth flows are CRITICAL security violations.**

- `grep -rn 'TODO\|FIXME\|stub\|placeholder' src/ | grep -i auth` must return 0 results
- SSO callbacks must validate tokens/assertions (not pass-through)
- Auth middleware must not have bypass paths outside explicit allowlists
```

### 5.2 Rule: All Paid Features Must Be Gated

**Add to CR table:**
```markdown
| CR-14 | All paid features must be server-side gated | VR-GREP |
```

**Add detailed section:**
```markdown
### CR-14: All Paid Features Must Be Server-Side Gated

**Every dashboard page and API route that is tier-restricted MUST enforce `requirePlan()` server-side. Client-side nav hiding is NOT sufficient.**

- Every page under `(dashboard)/` that shows paid features must call `requirePlan()` or equivalent
- API routes returning tier-restricted data must verify plan server-side
- Client-side hiding is supplementary only, never the sole gate
```

### 5.3 Rule: No Silent Security Fallbacks

**Add to CR table:**
```markdown
| CR-15 | Security mechanisms must fail hard | VR-GREP |
```

**Add detailed section:**
```markdown
### CR-15: No Silent Security Fallbacks

**Security mechanisms (encryption, auth, validation) MUST fail hard. Silent fallback to weaker security is prohibited.**

- Encryption failure must throw, never fall back to plaintext
- Auth failure must return 401/403, never serve content anyway
- Validation failure must reject input, never accept silently
```

### 5.4 Rule: Marketing Claims Must Be Tested

**Add to CR table:**
```markdown
| CR-16 | Marketing claims must match source data | VR-TEST |
```

**Add detailed section:**
```markdown
### CR-16: Marketing Claims Must Match Source Data

**Feature counts, tool counts, and tier claims displayed on the website MUST be derived from source data, not hardcoded. Discrepancies between data and display are HIGH severity.**

- Tool counts on marketing pages must come from config/database
- Tier badges must reflect actual tier from data source
- Pricing must match `massu.config.yaml` values
```

### 5.5 Rule: API Responses Must Not Leak Secrets

**Add to CR table:**
```markdown
| CR-17 | API responses must not leak secrets | VR-GREP |
```

**Add detailed section:**
```markdown
### CR-17: API Responses Must Not Leak Secrets

**API GET responses MUST explicitly select fields. `select('*')` is prohibited in API routes that return data to clients.**

- Every Supabase query in API GET handlers must use explicit `.select('field1, field2')`
- Fields named `secret`, `key`, `password`, `token` must never appear in GET responses
- Use DTO/projection patterns to control response shape
```

### 5.6 Monthly Full-Scope Audit

**Implementation**: Add a note to the `massu-codebase-audit.md` command header documenting the recommended monthly cadence. This is a process recommendation (no code artifact) documented in the command file itself.

**Add to massu-codebase-audit.md** header section:
```markdown
**Recommended cadence**: Run monthly to catch drift before it accumulates. Set a calendar reminder.
```

**Verification for ALL CR additions (5.1-5.5):**
```bash
# VR-GREP: All new CRs in CLAUDE.md table
grep 'CR-13' .claude/CLAUDE.md
grep 'CR-14' .claude/CLAUDE.md
grep 'CR-15' .claude/CLAUDE.md
grep 'CR-16' .claude/CLAUDE.md
grep 'CR-17' .claude/CLAUDE.md
# All must return matches

# VR-COUNT: Exactly 17 distinct CRs
grep -oE 'CR-[0-9]+' .claude/CLAUDE.md | sort -u | wc -l
# Must be 17 (CR-1 through CR-17)
```

---

## Implementation Priority

| Priority | Area | What | Key Deliverables | Effort |
|----------|------|------|------------------|--------|
| **P0** | 1.1 | Install git hooks (Husky) | `.husky/pre-commit`, `.husky/pre-push`, `package.json` update | 1 hour |
| **P0** | 5.1-5.5 | Add CR-13 through CR-17 to CLAUDE.md | 5 new CRs with VR types in `.claude/CLAUDE.md` | 30 min |
| **P0** | 2.3 | Remove phantom CR-35 references | Update 45 files in `.claude/` | 1 hour |
| **P1** | 2.1 | Upgrade security scanner script | 4 new checks in `scripts/massu-security-scanner.sh` | 2-3 hours |
| **P1** | 3.2 | Add MCP server integration tests | 3 test files + `test:integration` npm script | 4-6 hours |
| **P1** | 3.1 | Add website integration tests | 8 test files in massu-internal repo | 1 day |
| **P1** | 2.4 | Fix all broken commands/scripts | 41 duplicate name fixes, frontmatter, paths, Co-Authored-By | 2-3 hours |
| **P1** | 2.2 | Fix grep -oP portability | 4 replacements in `massu-push.md` | 30 min |
| **P1** | 2.5 | Create tooling self-test script | `scripts/massu-verify-tooling.sh` | 1-2 hours |
| **P2** | 1.2 | Update GitHub Actions CI | Add security scanner + integration tests to `ci.yml` | 1 hour |
| **P2** | 1.3 | Add deploy workflow | `deploy.yml` | 1 hour |
| **P2** | 4.1-4.5 | Update audit/review/commit/push commands | New phases/dimensions/gates/tiers | 3-4 hours |
| **P2** | 4.6 | Create massu-pre-launch command | `.claude/commands/massu-pre-launch.md` | 1-2 hours |
| **P2** | 3.3 | Create launch readiness script | `scripts/massu-launch-readiness.sh` | 1-2 hours |

---

## Deliverable Checklist

Total deliverables: 34

| # | Area | Deliverable | File(s) | Status |
|---|------|-------------|---------|--------|
| 1 | 1.1 | Install husky + lint-staged devDeps | `package.json` | DONE |
| 2 | 1.1 | Create pre-commit hook | `.husky/pre-commit` | DONE |
| 3 | 1.1 | Create pre-push hook | `.husky/pre-push` | DONE |
| 4 | 1.2 | Update CI pipeline | `.github/workflows/ci.yml` | DONE |
| 5 | 1.3 | Create deploy workflow | `.github/workflows/deploy.yml` | DONE |
| 6 | 2.1 | Add 4 security scanner checks | `scripts/massu-security-scanner.sh` | DONE |
| 7 | 2.2 | Fix grep -oP (4 instances) | `.claude/commands/massu-push.md` | DONE |
| 8 | 2.3 | Remove CR-35 refs (45 files) | `.claude/commands/*.md`, `.claude/settings.json`, `_shared-preamble.md` | DONE |
| 9 | 2.4a | Remove duplicate name: (41 files) | `.claude/commands/massu-*.md` | DONE |
| 10 | 2.4b | Add frontmatter to sync-public | `.claude/commands/massu-sync-public.md` | DONE |
| 11 | 2.4c | Create patterns directory | `.claude/patterns/.gitkeep` | DONE |
| 12 | 2.4d | Create incidents directory | `.claude/incidents/.gitkeep` | DONE |
| 13 | 2.4e | Create benchmarks directory | `.claude/benchmarks/.gitkeep` | DONE |
| 14 | 2.4f | Fix hardcoded paths | `.claude/commands/massu-feature-parity.md` | DONE |
| 15 | 2.4g | Fix subagent type | `.claude/commands/massu-checkpoint.md` | DONE |
| 16 | 2.4h | Fix Co-Authored-By | `.claude/commands/massu-checkpoint.md` | DONE |
| 17 | 2.5 | Create tooling self-test | `scripts/massu-verify-tooling.sh` | DONE |
| 18 | 3.1 | Create 8 website integration tests | `massu-internal/website/src/__tests__/integration/*.test.ts` | DONE |
| 19 | 3.2 | Create integration test directory | `packages/core/src/__tests__/integration/` | DONE |
| 20 | 3.2 | Create 3 MCP integration tests | `packages/core/src/__tests__/integration/*.test.ts` | DONE |
| 21 | 3.2 | Add test:integration npm scripts | `package.json`, `packages/core/package.json` | DONE |
| 22 | 3.3 | Create launch readiness script | `scripts/massu-launch-readiness.sh` | DONE |
| 23 | 4.1 | Add phases 14-17 to codebase-audit | `.claude/commands/massu-codebase-audit.md` | DONE |
| 24 | 4.2 | Add dimensions 8-12 to security-scan | `.claude/commands/massu-security-scan.md` | DONE |
| 25 | 4.3 | Add dimension 8 to review | `.claude/commands/massu-review.md` | DONE |
| 26 | 4.4 | Add Gate 8 to commit | `.claude/commands/massu-commit.md` | DONE |
| 27 | 4.5 | Add Tier 4 to push | `.claude/commands/massu-push.md` | DONE |
| 28 | 4.6 | Create pre-launch command | `.claude/commands/massu-pre-launch.md` | DONE |
| 29 | 5.1 | Add CR-13 to CLAUDE.md | `.claude/CLAUDE.md` | DONE |
| 30 | 5.2 | Add CR-14 to CLAUDE.md | `.claude/CLAUDE.md` | DONE |
| 31 | 5.3 | Add CR-15 to CLAUDE.md | `.claude/CLAUDE.md` | DONE |
| 32 | 5.4 | Add CR-16 to CLAUDE.md | `.claude/CLAUDE.md` | DONE |
| 33 | 5.5 | Add CR-17 to CLAUDE.md | `.claude/CLAUDE.md` | DONE |
| 34 | 5.6 | Add monthly cadence note | `.claude/commands/massu-codebase-audit.md` | DONE |

---

## Summary

The 119 issues happened because **the entire verification system is grep-based static analysis with zero enforcement**. The fix requires:

1. **Enforcement** -- Git hooks and CI that actually block bad code
2. **Runtime testing** -- Integration tests that verify behavior, not just syntax
3. **Logic-aware security** -- Scanner that checks auth flows, not just hardcoded keys
4. **Self-testing tools** -- A script that verifies the verification tools work
5. **New canonical rules** -- CR-13 through CR-17 covering auth, gating, encryption, claims, and API responses
6. **Broken tool fixes** -- grep -oP portability, phantom CR-35, duplicate name: fields, missing frontmatter

**After these changes, the categories of issues found in the review become structurally impossible to ship.**

---

**Document Version**: 1.5 (verification audit iteration 1 — all 34 deliverables verified DONE)
**Created**: 2026-02-21
**Last Updated**: 2026-02-21
